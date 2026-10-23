# H-MEM engine

This folder is the Meterless H-MEM engine, taken from
[meterless/meterless/engines/hmem/reference](https://github.com/Meterless/Meterless/tree/main/engines/hmem)
under the Apache-2.0 license (see `LICENSE`). Receipts builds on it in
`src/memory/findings.ts`, which stores investigation findings with query
provenance, recalls them per entity, and records analyst corrections.

Conformance: `npm run conformance` runs the official H-MEM suite
(`conformance/hmem/`) against this folder.
