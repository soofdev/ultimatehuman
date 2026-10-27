// The theme is the vendored reference config (tailwind.config.mjs, verbatim).
// Its content globs already cover ./app; the radar's own pages add ./src.
import reference from "./tailwind.config.mjs";

export default { ...reference, content: [...reference.content, "./index.html", "./src/**/*.{js,jsx,ts,tsx}"] };
