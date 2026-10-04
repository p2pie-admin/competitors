import type { SourceDef } from "../core/types";
import { bestchange } from "./bestchange";
import { kursexpert } from "./kursexpert";

// Add further monitorings here (each is a SourceDef with its own jobs, parsers and policy).
export const SOURCES: SourceDef[] = [bestchange, kursexpert];
