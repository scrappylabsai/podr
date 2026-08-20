#!/usr/bin/env node
// podsh lanes — what dsh hosts are up, and which models each one serves.
import { probeLanes, renderLanes, laneList } from "./lanes.mjs";
const here = process.env.PODSH_HOST || process.env.EVOLV_HOST || null;
const lanes = await probeLanes();
console.log(`lanes (${process.env.PODSH_LANES ? "from PODSH_LANES" : "scanned " + laneList()[0] + "-" + laneList().at(-1).split(":")[1]}):`);
console.log(renderLanes(lanes.filter(l => l.up), { hereHost: here?.replace(/^https?:\/\//, "") }));
