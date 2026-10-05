import type { SourceDef } from "../core/types";
import { bestchange } from "./bestchange";
import { kursexpert } from "./kursexpert";
import { changeinfo } from "./changeinfo";
import { emon } from "./emon";
import { wellcrypto } from "./wellcrypto";
import { obmify } from "./obmify";

// Add further monitorings here (each is a SourceDef with its own jobs, parsers and policy).
export const SOURCES: SourceDef[] = [bestchange, kursexpert, changeinfo, emon, wellcrypto, obmify];
