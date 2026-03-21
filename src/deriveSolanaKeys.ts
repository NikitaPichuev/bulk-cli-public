#!/usr/bin/env node
import fs from "fs";
import path from "path";

import { Command } from "commander";
import bs58Package from "bs58";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";

const bs58 = bs58Package;

type PathType = "bip44Change" | "bip44" | "deprecated";

const program = new Command();

program
  .name("derive-solana-keys")
  .description("Offline converter from seed phrases to Solana private keys for Phantom-compatible derivation paths")
  .option("--input <path>", "Input file with one seed phrase per line", ".seeds.txt")
  .option("--output <path>", "Output wallets file", ".wallets.json")
  .option("--path-type <type>", "Phantom path type: bip44Change, bip44, deprecated", "bip44Change")
  .option("--start-index <n>", "Start derivation index", "0")
  .option("--count <n>", "How many account indices to derive from each seed", "1")
  .option("--format <type>", "Output format: string or object", "string")
  .action((options: {
    input: string;
    output: string;
    pathType: PathType;
    startIndex: string;
    count: string;
    format: "string" | "object";
  }) => {
    const inputPath = resolveFile(options.input);
    const outputPath = resolveFile(options.output);
    const startIndex = Number(options.startIndex);
    const count = Number(options.count);

    if (!Number.isInteger(startIndex) || startIndex < 0) {
      throw new Error("start-index must be a non-negative integer.");
    }

    if (!Number.isInteger(count) || count <= 0) {
      throw new Error("count must be a positive integer.");
    }

    if (!["bip44Change", "bip44", "deprecated"].includes(options.pathType)) {
      throw new Error("path-type must be one of: bip44Change, bip44, deprecated.");
    }

    if (!["string", "object"].includes(options.format)) {
      throw new Error("format must be string or object.");
    }

    const phrases = loadSeedPhrases(inputPath);
    const derived = phrases.flatMap((phrase, phraseIndex) =>
      deriveProfilesForPhrase(phrase, phraseIndex, options.pathType, startIndex, count, options.format)
    );

    fs.writeFileSync(outputPath, `${JSON.stringify(derived, null, 2)}\n`, "utf8");

    console.log(JSON.stringify({
      ok: true,
      input: inputPath,
      output: outputPath,
      seeds: phrases.length,
      derived: derived.length,
      pathType: options.pathType,
      startIndex,
      count,
      format: options.format
    }, null, 2));
  });

program.parse(process.argv);

function resolveFile(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

function loadSeedPhrases(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }

  const lines = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (lines.length === 0) {
    throw new Error(`No seed phrases found in ${filePath}`);
  }

  for (const [index, phrase] of lines.entries()) {
    if (!bip39.validateMnemonic(phrase)) {
      throw new Error(`Invalid seed phrase at line ${index + 1}`);
    }
  }

  return lines;
}

function deriveProfilesForPhrase(
  phrase: string,
  phraseIndex: number,
  pathType: PathType,
  startIndex: number,
  count: number,
  format: "string" | "object"
): Array<string | { name: string; ownerSecretKey: string; accountAddress: string; derivationPath: string }> {
  const seed = bip39.mnemonicToSeedSync(phrase).toString("hex");
  const results: Array<string | { name: string; ownerSecretKey: string; accountAddress: string; derivationPath: string }> = [];

  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    const derivationPath = getDerivationPath(pathType, index);
    const derived = derivePath(derivationPath, seed);
    const keypair = Keypair.fromSeed(derived.key);
    const ownerSecretKey = bs58.encode(Buffer.from(keypair.secretKey));
    const accountAddress = keypair.publicKey.toBase58();

    if (format === "string") {
      results.push(ownerSecretKey);
      continue;
    }

    results.push({
      name: `seed-${phraseIndex + 1}-account-${index + 1}`,
      ownerSecretKey,
      accountAddress,
      derivationPath
    });
  }

  return results;
}

function getDerivationPath(pathType: PathType, index: number): string {
  switch (pathType) {
    case "bip44Change":
      return `m/44'/501'/${index}'/0'`;
    case "bip44":
      return `m/44'/501'/${index}'`;
    case "deprecated":
      return `m/501'/${index}'/0/0`;
    default:
      throw new Error(`Unsupported path type: ${pathType satisfies never}`);
  }
}
