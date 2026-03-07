/* Preact JSX runtime shim — maps react/jsx-runtime to Preact's h() */
import { h, Fragment } from "preact";
export { Fragment };
export function jsx(type, props, key) {
  const { children, ...rest } = props || {};
  if (key !== undefined) rest.key = key;
  return h(type, rest, children);
}
export const jsxs = jsx;
export const jsxDEV = jsx;
