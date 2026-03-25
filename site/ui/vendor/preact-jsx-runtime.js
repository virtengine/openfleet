/* Preact JSX runtime shim — maps react/jsx-runtime to Preact's h() */
import { h, Fragment } from "preact";
export { Fragment };
export function jsx(type, props, key) {
  if (type == null) type = Fragment;
  if (Array.isArray(type)) {
    console.warn("[jsx-runtime] Array passed as element type — wrapping in Fragment. Length:", type.length, new Error().stack);
    return h(Fragment, null, ...type);
  }
  const { children, ...rest } = props || {};
  if (key !== undefined) rest.key = key;
  return h(type, rest, children);
}
export const jsxs = jsx;
export const jsxDEV = jsx;
