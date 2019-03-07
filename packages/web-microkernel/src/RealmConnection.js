import * as _ from './lodash-es/lodash.js'

// Polyfill the behavior of addEventListener(type, listener, { once: true }))
// because for an unknown reason the above isn't working in Chrome 72.
const addEventListenerOnce = (target, type, listener) => {
  const onceListener = (...args) => {
    const result = listener(...args)
    target.removeEventListener(type, onceListener)
    return result
  }

  target.addEventListener(type, onceListener)
}

const firstEvent = (target, type) =>
  new Promise(resolve => {
    addEventListenerOnce(target, type, resolve)
  })

const cutoff = 25

export const inspect = value => {
  const stringified = JSON.stringify(value)

  return stringified.length > cutoff
    ? `${stringified.slice(0, cutoff)}...`
    : stringified
}

// Create an unforgeable key.
const Key = () => {
  const array = new Uint32Array(1)
  window.crypto.getRandomValues(array)
  return array[0].toString(36)
}

const decoders = {}
const types = []

// The types are defined in the same order they are tested.

types.push(
  {
    name: `boolean`,
    test: _.isBoolean,
    encoder: (context, boolean) => boolean,
    decoder: (context, code) => code
  },

  {
    name: `null`,
    test: _.isNull,
    encoder: () => null,
    decoder: () => null
  },

  {
    name: `number`,
    test: _.isNumber,
    encoder: (context, number) => number,
    decoder: (context, code) => code
  },

  {
    name: `string`,
    test: _.isString,
    encoder: (context, string) => string,
    decoder: (context, code) => code
  },

  {
    name: `undefined`,
    test: _.isUndefined,
    encoder: () => undefined,
    decoder: () => undefined
  },

  {
    name: `array`,
    test: Array.isArray,
    encoder: (context, array) =>
      array.map(value => encodeToDictionary(context, value)),

    decoder: (context, codes) =>
      codes.map(code => decodeFromDictionary(context, code))
  }
)

// error

const isError = value => value instanceof Error

const encodeError = (context, error) => ({
  // The `message` property has to be handled separately.
  message: encodeToDictionary(context, error.message),

  // Encode all attributes (not just standard `message` and `name`) for
  // the benefit of Axios.
  pairs: Object.entries(error).map(([key, value]) => [
    key,
    encodeToDictionary(context, value)
  ])
})

const decodeError = (context, { pairs, message }) =>
  Object.assign(
    Error(decodeFromDictionary(context, message)),
    ...pairs.map(([key, value]) => ({
      [key]: decodeFromDictionary(context, value)
    }))
  )

types.push({
  name: `error`,
  test: isError,
  encoder: encodeError,
  decoder: decodeError
})

// function

const encodeFunction = ({ functionKeys, keyedReferences }, func) => {
  if (!keyedReferences) {
    throw new TypeError(`Cannot encode functions outside of exports.`)
  }

  if (!functionKeys.has(func)) {
    const key = Key()
    functionKeys.set(func, key)
    keyedReferences[key] = func
  }

  return { key: functionKeys.get(func), length: func.length }
}

const decodeFunction = (context, { key: functionKey, length }) => {
  const { keyedReferences, reportExceptionsIn } = context

  if (!(functionKey in keyedReferences)) {
    const proxyFunction = (...args) =>
      new Promise(
        reportExceptionsIn((resolve, reject) => {
          const returnValueKey = Key()
          keyedReferences[returnValueKey] = { resolve, reject }

          // Function application isn't a type so encode its dictionary
          // manually.
          context.postMessage({
            0: [
              `functionApply`,
              {
                args: encodeWithoutPersistentReferences(context, args),
                functionKey,
                returnValueKey
              }
            ]
          })
        })
      )

    Object.defineProperty(proxyFunction, `length`, { value: length })
    keyedReferences[functionKey] = proxyFunction
  }

  return keyedReferences[functionKey]
}

decoders.functionApply = (context, { args, functionKey, returnValueKey }) => {
  const { keyedReferences, postMessage, reportExceptionsIn } = context
  const func = keyedReferences[functionKey]
  const decodedArgs = decode(context, args)

  const functionReturn = encoding => {
    // Function return isn't a type so encode its dictionary manually.
    postMessage({ 0: [`functionReturn`, { returnValueKey, ...encoding }] })
  }

  const resolve = reportExceptionsIn(value => {
    functionReturn({ value: encodeWithoutPersistentReferences(context, value) })
  })

  const reject = reportExceptionsIn(reason => {
    functionReturn({
      reason: encodeWithoutPersistentReferences(context, reason)
    })
  })

  try {
    func(...decodedArgs).then(resolve, reject)
  } catch (exception) {
    throw new TypeError(
      `Only asynchronous functions can be called across realms.`
    )
  }
}

decoders.functionReturn = (context, { returnValueKey, reason, value }) => {
  const { keyedReferences } = context
  const { reject, resolve } = keyedReferences[returnValueKey]
  delete keyedReferences[returnValueKey]

  if (reason) {
    reject(decode(context, reason))
  } else {
    resolve(decode(context, value))
  }
}

types.push({
  name: `function`,
  test: _.isFunction,
  encoder: encodeFunction,
  decoder: decodeFunction
})

// map

const encodeMap = (context, map) =>
  [...map.entries()].map(([key, value]) => [
    encodeToDictionary(context, key),
    encodeToDictionary(context, value)
  ])

const decodeMap = (context, pairs) =>
  new Map(
    pairs.map(([encodedKey, encodedValue]) => [
      decodeFromDictionary(context, encodedKey),
      decodeFromDictionary(context, encodedValue)
    ])
  )

types.push({
  name: `map`,
  test: _.isMap,
  encoder: encodeMap,
  decoder: decodeMap
})

// set

const encodeSet = (context, set) =>
  [...set].map(value => encodeToDictionary(context, value))

const decodeSet = (context, codes) =>
  new Set(codes.map(code => decodeFromDictionary(context, code)))

types.push({
  name: `set`,
  test: _.isSet,
  encoder: encodeSet,
  decoder: decodeSet
})

// object

const encodeObject = (context, object) =>
  Object.entries(object).map(([key, value]) => [
    key,
    encodeToDictionary(context, value)
  ])

const decodeObject = (context, pairs) =>
  Object.assign(
    {},
    ...pairs.map(([key, encodedValue]) => ({
      [key]: decodeFromDictionary(context, encodedValue)
    }))
  )

types.push({
  name: `object`,
  test: _.isPlainObject,
  encoder: encodeObject,
  decoder: decodeObject
})

// end of type definitions

types.forEach(({ name, decoder }) => {
  decoders[name] = decoder
})

const encodeToDictionary = (context, value) => {
  const { codes, dictionary } = context

  if (codes.has(value)) {
    return codes.get(value)
  }

  const code = codes.size

  for (const { name, test, encoder } of types) {
    if (test(value)) {
      codes.set(value, code)
      dictionary[code] = [name, encoder(context, value)]
      return code
    }
  }

  throw new TypeError(`Don't know how to encode "${inspect(value)}".`)
}

const encode = (context, value) => {
  const dictionary = {}

  try {
    encodeToDictionary({ ...context, codes: new Map(), dictionary }, value)
  } catch (exception) {
    throw new Error(`Error while encoding ${inspect(value)}: ${exception}.`)
  }

  return dictionary
}

const encodeWithoutPersistentReferences = (context, value) =>
  encode(
    {
      ...context,
      functionKeys: null,
      keyedReferences: null
    },
    value
  )

const decodeFromDictionary = (context, code) => {
  const { dictionary, decodedValues } = context

  if (!(code in decodedValues)) {
    const [type, encoding] = dictionary[code]
    const decoder = decoders[type]

    if (decoder === undefined) {
      throw new TypeError(`Don't know how to decode type ${inspect(type)}.`)
    }

    decodedValues[code] = decoder(context, encoding)
  }

  // Freeze the newly created value because it's read-only:  Changes wouldn't
  // otherwise propogate back to the original value in the other realm.
  return Object.freeze(decodedValues[code])
}

const decode = (context, dictionary) =>
  decodeFromDictionary({ ...context, decodedValues: new Map(), dictionary }, 0)

export default async ({ exports, input, output, outputOrigin }) => {
  const postMessage = message => {
    // console.log(`-> ${outputOrigin} ${JSON.stringify(message)}`)
    output.postMessage(message, outputOrigin)
  }

  const eventTarget = new EventTarget()

  const reportExceptionsIn = callback => (...args) => {
    try {
      return callback(...args)
    } catch (exception) {
      eventTarget.dispatchEvent(new ErrorEvent(`error`, exception))
    }
  }

  const context = {
    functionKeys: new Map(),
    keyedReferences: {},
    postMessage,
    reportExceptionsIn
  }

  const postExports = () => postMessage(encode(context, exports))
  postExports()
  const { data } = await firstEvent(input, `message`)
  const imports = decode(context, data)

  // We've already posted our exports but post them a second time in case the
  // other realm wasn't listening yet.  The fact that we've received a handshake
  // means they're listening now.  Posting the exports is idempotent.
  postExports()

  // Now that we've completed the handshake, listen for all future message
  // events.

  const messageListener = reportExceptionsIn(({ data }) => {
    // console.log(`<- ${JSON.stringify(data)}`)
    decode(context, data)
  })

  input.addEventListener(`message`, messageListener)

  return Object.assign(eventTarget, {
    close: () => {
      input.removeEventListener(`message`, messageListener)
    },

    imports
  })
}
