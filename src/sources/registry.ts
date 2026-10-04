import type { SourceDef } from "../core/types";
import { bestchange } from "./bestchange";

// Add further monitorings here (each is a SourceDef with its own jobs, parsers and policy).
export const SOURCES: SourceDef[] = [bestchange];
