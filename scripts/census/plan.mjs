// Plans a split census from CENSUS_DIR/registry-remotes.json: writes shards.json and prints
// the job indices as a JSON array (for a workflow matrix). See shard.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { plan, jobs } from "./shard.mjs";

const dir = process.env.CENSUS_DIR;
const reg = JSON.parse(readFileSync(`${dir}/registry-remotes.json`, "utf8"));
const p = plan(reg.servers.filter((s) => !s.templated), Number(process.env.HASHED ?? 4));
writeFileSync(`${dir}/shards.json`, JSON.stringify(p, null, 2) + "\n");
console.error(`jobs ${jobs(p)}: own job for ${p.big.join(", ") || "none"} + ${p.hashed} split by host`);
console.log(JSON.stringify(Array.from({ length: jobs(p) }, (_, i) => i)));
