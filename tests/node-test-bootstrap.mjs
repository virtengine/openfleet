// CLAUDE:SUMMARY remove Vitest imports from the Node test bootstrap so node --test never initializes Vitest APIs outside a runner.
import "./runtime-bootstrap.mjs";
