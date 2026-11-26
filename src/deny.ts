import { posix } from "node:path";
import { isDenied } from "@staix/agent-mem/platform";

export const foldPathSegment = (segment: string): string =>
  segment.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").toLowerCase().toUpperCase().toLowerCase();

/** Check both the supplied spelling and its equivalent folded repository path. */
export function deniedReportPath(value: string): boolean {
  const path = value.trim().replaceAll("\\", "/");
  const folded = path.split("/").map(foldPathSegment).join("/");
  return [path, folded].some(spelling => isDenied(spelling) || isDenied(posix.normalize(spelling)));
}
