// The browser modules import three.js as '/vendor/three.module.js' (a URL the
// server maps to node_modules). Under Node that path has to be resolved to the
// real file, which is all this hook does.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = {
  '/vendor/three.module.js': path.join(root, 'server/node_modules/three/build/three.module.js'),
  '/vendor/OrbitControls.js': path.join(root, 'server/node_modules/three/examples/jsm/controls/OrbitControls.js'),
};

export async function resolve(specifier, context, nextResolve) {
  if (VENDOR[specifier]) return { url: pathToFileURL(VENDOR[specifier]).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
