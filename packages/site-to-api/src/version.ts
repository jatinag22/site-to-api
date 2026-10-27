import pkg from '../package.json' with { type: 'json' }

/** Version of the installed package, written into every generated file. */
export const VERSION: string = pkg.version
