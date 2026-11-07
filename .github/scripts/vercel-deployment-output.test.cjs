const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const release = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");

test("fork releases do not deploy the removed upstream hosted web or marketing apps", () => {
  assert.doesNotMatch(release, /vercel/i);
  assert.doesNotMatch(release, /name: Build staged deployment/);
});

test("the removed upstream hosted web preview workflow stays absent", () => {
  assert.equal(existsSync(join(__dirname, "../workflows/web-preview.yml")), false);
});
