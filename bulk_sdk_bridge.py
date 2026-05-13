#!/usr/bin/env python
import json
import os
import struct
import sys
import time
from typing import Any

import base58
import requests
from nacl.signing import SigningKey


TIME_IN_FORCE_MAP = {
    "GTC": 0,
    "IOC": 1,
    "ALO": 2,
    "gtc": 0,
    "ioc": 1,
    "alo": 2,
}


def write_u64(value: int) -> bytes:
    return struct.pack("<Q", value)


def write_u32(value: int) -> bytes:
    return struct.pack("<I", value)


def write_u8(value: int) -> bytes:
    return struct.pack("B", value)


def write_i16(value: int) -> bytes:
    return struct.pack("<h", value)


def write_f64(value: float) -> bytes:
    return struct.pack("<d", value)


def write_bool(value: bool) -> bytes:
    return bytes([1 if value else 0])


def write_string(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return write_u64(len(encoded)) + encoded


def write_strings(values: list[str]) -> bytes:
    parts = [write_u64(len(values))]
    for value in values:
        parts.append(write_string(value))
    return b"".join(parts)


def write_fixedpoint(value: float) -> bytes:
    return struct.pack("<Q", int(round(float(value) * 1e8)))


def write_optional_fixedpoint(value: float | None) -> bytes:
    if value is None:
        return bytes([0x00])
    return b"".join([bytes([0x01]), write_fixedpoint(value)])


def decode_and_validate_key(key: str) -> bytes:
    key_bytes = base58.b58decode(key)
    if len(key_bytes) != 32:
        raise ValueError(f"Key must be 32 bytes, got {len(key_bytes)}")
    return key_bytes


def serialize_action(action: dict[str, Any]) -> bytes:
    if "m" in action:
        order = action["m"]
        return b"".join([
            write_u32(0),
            write_string(order["c"]),
            write_bool(bool(order["b"])),
            write_fixedpoint(float(order["sz"])),
            write_bool(bool(order.get("r", False))),
            write_bool(bool(order.get("i", False))),
        ])

    if "l" in action:
        order = action["l"]
        return b"".join([
            write_u32(1),
            write_string(order["c"]),
            write_bool(bool(order["b"])),
            write_fixedpoint(float(order["px"])),
            write_fixedpoint(float(order["sz"])),
            write_u32(TIME_IN_FORCE_MAP[str(order.get("tif", "GTC"))]),
            write_bool(bool(order.get("r", False))),
            write_bool(bool(order.get("i", False))),
        ])

    if "cx" in action:
        order = action["cx"]
        return b"".join([
            write_u32(3),
            write_string(order["c"]),
            decode_and_validate_key(order["oid"]),
        ])

    if "cxa" in action:
        order = action["cxa"]
        return b"".join([
            write_u32(4),
            write_strings(list(order["c"])),
        ])

    if "faucet" in action or "Faucet" in action:
        order = action.get("faucet") or action.get("Faucet")
        if "amount" in order:
            return b"".join([
                write_u32(16),
                decode_and_validate_key(order["u"]),
                write_bool(True),
                write_f64(float(order["amount"])),
            ])
        return b"".join([
            write_u32(16),
            decode_and_validate_key(order["u"]),
            write_bool(False),
        ])

    if "agentWalletCreation" in action:
        order = action["agentWalletCreation"]
        return b"".join([
            write_u32(17),
            decode_and_validate_key(order["a"]),
            write_bool(bool(order["d"])),
        ])

    if "updateUserSettings" in action:
        order = action["updateUserSettings"]
        settings = order["m"]
        if isinstance(settings, dict):
            settings = list(settings.items())
        parts = [write_u32(18), write_u64(len(settings))]
        for symbol, leverage in settings:
            parts.append(write_string(str(symbol)))
            parts.append(write_f64(float(leverage)))
        return b"".join(parts)

    if "whiteListFaucet" in action:
        order = action["whiteListFaucet"]
        return b"".join([
            write_u32(19),
            decode_and_validate_key(order["target"]),
            write_bool(bool(order["whitelist"])),
        ])

    raise ValueError(f"Unsupported action: {json.dumps(action, ensure_ascii=False)}")


def serialize_transaction(actions: list[dict[str, Any]], nonce: int, account: str) -> bytes:
    parts = [write_u64(len(actions))]
    for action in actions:
        parts.append(serialize_action(action))
    parts.append(write_u64(int(nonce)))
    parts.append(decode_and_validate_key(account))
    return b"".join(parts)


def sign_transaction(private_key: str, account: str, actions: list[dict[str, Any]], nonce: int) -> dict[str, Any]:
    private_key_bytes = base58.b58decode(private_key)
    signing_key = SigningKey(private_key_bytes[:32])
    public_key = base58.b58encode(bytes(signing_key.verify_key)).decode()
    message = serialize_transaction(actions, nonce, account)
    signature = base58.b58encode(signing_key.sign(message).signature).decode()
    return {
        "actions": actions,
        "nonce": str(int(nonce)),
        "account": account,
        "signer": public_key,
        "signature": signature,
    }


def main() -> int:
    payload = json.load(sys.stdin)
    operation = payload.get("operation", "submit")

    if operation != "submit":
        raise ValueError(f"Unsupported operation: {operation}")

    base_url = str(payload["baseUrl"]).rstrip("/")
    private_key = str(payload["privateKey"])
    account = str(payload["account"])
    actions = payload["actions"]
    nonce = int(payload.get("nonce") or time.time_ns())
    proxy_url = payload.get("proxyUrl")
    timeout = int(payload.get("timeoutSeconds") or 20)

    proxies = None
    if proxy_url:
        proxies = {
            "http": proxy_url,
            "https": proxy_url,
        }

    envelope = sign_transaction(private_key, account, actions, nonce)
    retry_statuses = {408, 425, 429, 500, 502, 503, 504}
    response = None
    last_error = None
    for attempt in range(1, 4):
        try:
            response = requests.post(
                f"{base_url}/order",
                json=envelope,
                timeout=timeout,
                proxies=proxies,
            )
            if response.status_code not in retry_statuses or attempt == 3:
                response.raise_for_status()
                break
        except Exception as error:
            last_error = error
            if attempt == 3:
                raise
        time.sleep(0.75 * attempt)

    if response is None:
        raise last_error if last_error else RuntimeError("No response from SDK bridge request")

    json.dump(response.json(), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
