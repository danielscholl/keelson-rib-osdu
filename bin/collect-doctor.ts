#!/usr/bin/env bun
import { buildDoctorBoard, fetchSetupCheck } from "../src/setup.ts";

const { result, error } = await fetchSetupCheck();
if (error) console.error(`[rib-osdu] doctor degraded: ${error}`);
process.stdout.write(JSON.stringify(buildDoctorBoard(result)));
