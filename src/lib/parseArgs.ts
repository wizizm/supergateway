import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

type ArgType =
  | StringConstructor
  | NumberConstructor
  | ArrayConstructor
  | BooleanConstructor

interface ArgOption {
  type: ArgType
  description: string
  choices?: readonly string[]
  default?: any
}

type ArgsSpec = Record<string, ArgOption>

export function parseArgs<T>(spec: ArgsSpec): T {
  const yargsInstance = yargs(hideBin(process.argv))

  Object.entries(spec).forEach(([key, option]) => {
    yargsInstance.option(key, {
      type:
        option.type === String
          ? 'string'
          : option.type === Number
            ? 'number'
            : option.type === Array
              ? 'array'
              : option.type === Boolean
                ? 'boolean'
                : 'string',
      description: option.description,
      choices: option.choices,
      default: option.default,
    })
  })

  return yargsInstance.help().parseSync() as T
}
