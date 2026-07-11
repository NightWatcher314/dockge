import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeStackFiles } from "../stack-files";

let stacksDir : string;

before(async () => {
    stacksDir = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-stack-save-"));
});

after(async () => {
    await fs.rm(stacksDir, {
        recursive: true,
        force: true,
    });
});

test("saving an existing stack persists compose yaml and env", async () => {
    const dir = path.join(stacksDir, "existing");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "compose.yaml"), "services:\n  old: {}\n");
    await fs.writeFile(path.join(dir, ".env"), "OLD=1\n");

    writeStackFiles(dir, "compose.yaml", "services: {}\n", "NEW=1\n");

    assert.equal(await fs.readFile(path.join(dir, "compose.yaml"), "utf8"), "services: {}\n");
    assert.equal(await fs.readFile(path.join(dir, ".env"), "utf8"), "NEW=1\n");
});

test("an explicit empty env clears an existing env file", async () => {
    const dir = path.join(stacksDir, "clear-env");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "compose.yaml"), "services: {}\n");
    await fs.writeFile(path.join(dir, ".env"), "OLD=1\n");

    writeStackFiles(dir, "compose.yaml", "services: {}\n", "");

    assert.equal(await fs.readFile(path.join(dir, ".env"), "utf8"), "");
});

test("a new stack with no env does not create an empty env file", async () => {
    const dir = path.join(stacksDir, "new-stack");
    await fs.mkdir(dir);

    writeStackFiles(dir, "compose.yaml", "services: {}\n", "");

    assert.equal(await fs.readFile(path.join(dir, "compose.yaml"), "utf8"), "services: {}\n");
    await assert.rejects(fs.access(path.join(dir, ".env")));
});
