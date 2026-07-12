// OpenClaw plugin entries are plain objects. Keeping this tiny adapter makes
// unit tests independent from a globally installed OpenClaw package.
export function definePluginEntry(entry) {
  return entry;
}
