/** Bun 1.3.14 exposes compiled entries as virtual `$bunfs` argv[1] paths. */
export const isCompiledAgent = process.argv[1]?.includes("/$bunfs/") === true;
