import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);
const realEsbuild = requireModule("esbuild/lib/main.js");

async function build(options) {
  return realEsbuild.buildSync(options);
}

async function transform(input, options) {
  return realEsbuild.transformSync(input, options);
}

async function formatMessages(messages, options) {
  return realEsbuild.formatMessagesSync(messages, options);
}

async function analyzeMetafile(metafile, options) {
  return realEsbuild.analyzeMetafileSync(metafile, options);
}

const defaultExport = new Proxy(realEsbuild, {
  get(target, prop, receiver) {
    if (prop === "build") return build;
    if (prop === "transform") return transform;
    if (prop === "formatMessages") return formatMessages;
    if (prop === "analyzeMetafile") return analyzeMetafile;
    return Reflect.get(target, prop, receiver);
  },
});

export { analyzeMetafile, build, formatMessages, transform };

export const {
  analyzeMetafileSync,
  buildSync,
  context,
  formatMessagesSync,
  initialize,
  stop,
  transformSync,
  version,
} = realEsbuild;

export default defaultExport;
