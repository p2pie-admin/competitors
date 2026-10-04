import { runMatchJob as runGenericMatch } from "../../core/matchJob";
import { SOURCE_ID } from "./constants";
import type { JobCtx } from "../../core/types";
import { applySeed } from "./list";

export const runMatchJob = (ctx: JobCtx): Promise<Record<string, unknown>> => runGenericMatch(ctx, SOURCE_ID, () => applySeed(ctx));
