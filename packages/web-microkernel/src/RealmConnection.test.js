import Connection, * as internal from './RealmConnection.js'

it(`stringifies a value for debugging`, () => {
  expect(internal.inspect([{ a: `This is a long string.` }])).toEqual(
    `[{"a":"This is a long str...`
  )
})

// a cheap exercise of the destructured clone operation that occurs between
// realm boundaries
const DestructuredClone = () => {
  const resolves = []

  window.addEventListener(`message`, ({ data }) => {
    const resolve = resolves.shift()
    resolve(data)
  })

  return value =>
    new Promise(resolve => {
      resolves.push(resolve)
      window.postMessage(value)
    })
}

const destructuredClone = DestructuredClone()

const MockRealm = origin => {
  let target

  return Object.assign(new EventTarget(), {
    // Connect to another realm.
    connect: realm => {
      target = realm
    },

    postMessage: async (message, targetOrigin) => {
      expect(targetOrigin).toEqual(origin)

      if (target) {
        const event = new MessageEvent(`message`, {
          data: await destructuredClone(message)
        })

        target.dispatchEvent(event)
      }
    }
  })
}

const createMockRealms = () => {
  const a = MockRealm(`a`)
  const b = MockRealm(`b`)
  a.connect(b)
  b.connect(a)
  return { a, b }
}

xdescribe(`type checkers`, () => {
  it(`array`, () => {
    expect(realms.is.array(null)).toEqual(false)
    expect(realms.is.array([1, 2, 3])).toEqual(true)
  })

  it(`boolean`, () => {
    expect(realms.is.boolean(null)).toEqual(false)
    expect(realms.is.boolean(true)).toEqual(true)
  })

  it(`function`, () => {
    expect(realms.is.function(null)).toEqual(false)
    expect(realms.is.function(() => {})).toEqual(true)
  })

  it(`map`, () => {
    expect(realms.is.map(null)).toEqual(false)
    expect(realms.is.map(new Map([[`a`, 1], [`b`, 2], [`c`, 3]]))).toEqual(true)
  })

  it(`null`, () => {
    expect(realms.is.null(undefined)).toEqual(false)
    expect(realms.is.null(null)).toEqual(true)
  })

  it(`number`, () => {
    expect(realms.is.number(null)).toEqual(false)
    expect(realms.is.number(42)).toEqual(true)
  })

  it(`plain object`, () => {
    expect(realms.is.object(null)).toEqual(false)
    expect(realms.is.object({ a: 1, b: 2, c: 3 })).toEqual(true)
  })

  it(`set`, () => {
    expect(realms.is.set(null)).toEqual(false)
    expect(realms.is.set(new Set([1, 2, 3]))).toEqual(true)
  })

  it(`string`, () => {
    expect(realms.is.string(null)).toEqual(false)
    expect(realms.is.string(`value`)).toEqual(true)
  })

  it(`undefined`, () => {
    expect(realms.is.undefined(null)).toEqual(false)
    expect(realms.is.undefined(undefined)).toEqual(true)
  })
})

// Create two test connections and serialize a value across them.
const serialize = async exports => {
  const { a, b } = createMockRealms()

  const connection1Promise = Connection({
    exports,
    input: a,
    output: a,
    outputOrigin: `a`
  })

  const connection2Promise = Connection({
    input: b,
    output: b,
    outputOrigin: `b`
  })

  const [connection1, connection2] = await Promise.all([
    connection1Promise,
    connection2Promise
  ])

  connection1.addEventListener(`error`, console.error)
  connection2.addEventListener(`error`, console.error)

  const close = () => {
    connection1.close()
    connection2.close()
  }

  return { close, imports: connection2.imports }
}

describe(`serializes values across realm boundaries`, () => {
  it(`array`, async () => {
    const exports = [1, 2, 3]
    const { close, imports } = await serialize(exports)
    expect(imports).toEqual(exports)
    close()
  })

  it(`boolean`, async () => {
    const exports = true
    const { close, imports } = await serialize(exports)
    expect(imports).toEqual(exports)
    close()
  })

  it(`creates consistent object references`, async () => {
    const object = { a: 1, b: 2, c: 3 }
    const exports = [object, object]
    const { close, imports } = await serialize(exports)
    const [left, right] = imports
    expect(left).toBe(right)
    close()
  })

  it(`Error`, async () => {
    const exports = Error(`message`)
    exports.name = `name`

    // Axios adds extra properties to errors.
    exports.extra = `extra`

    const { close, imports } = await serialize(exports)
    expect(imports instanceof Error).toEqual(true)
    expect(imports).toEqual(exports)
    close()
  })

  it(`freezes serialized values`, async () => {
    const exports = [{ a: 1 }]
    const { close, imports } = await serialize(exports)
    expect(Object.isFrozen(imports)).toEqual(true)
    expect(Object.isFrozen(imports[0])).toEqual(true)
    close()
  })

  describe(`function`, () => {
    it(`has the same arguments length`, async () => {
      const exports = (a, b) => a + b
      const { close, imports } = await serialize(exports)
      expect(imports.length).toEqual(exports.length)
      close()
    })

    it(`encodes arguments`, async () => {
      const exports = async (a, b) => [a, b]
      const { close, imports } = await serialize(exports)
      const object = {}
      const [serializedA, serializedB] = await imports(object, object)
      expect(serializedA).not.toBe(object)
      expect(serializedA).toBe(serializedB)
      close()
    })

    it(`returns value`, async () => {
      const exports = async (a, b) => a + b
      const { close, imports } = await serialize(exports)
      expect(await imports(1, 2)).toEqual(3)
      close()
    })

    it(`fails with synchronous functions`, async done => {
      const { a, b } = createMockRealms()
      const exports = (a, b) => a + b

      const connection1Promise = Connection({
        exports,
        input: a,
        output: a,
        outputOrigin: `a`
      })

      const connection2 = await Connection({
        input: b,
        output: b,
        outputOrigin: `b`
      })

      const connection1 = await connection1Promise
      connection2.imports()

      connection1.addEventListener(`error`, ({ message }) => {
        expect(message).toEqual(
          `Only asynchronous functions can be called across realms.`
        )

        connection1.close()
        connection2.close()
        done()
      })
    })

    it(`allows functions only within exports`, async done => {
      const { a, b } = createMockRealms()
      const compose = async (f, g) => x => f(g(x))

      const connection1Promise = Connection({
        exports: compose,
        input: a,
        output: a,
        outputOrigin: `a`
      })

      const connection2 = await Connection({
        input: b,
        output: b,
        outputOrigin: `b`
      })

      const connection1 = await connection1Promise

      connection2.addEventListener(`error`, ({ message }) => {
        expect(
          message.includes(`Cannot encode functions outside of exports.`)
        ).toEqual(true)

        connection1.close()
        connection2.close()
        done()
      })

      connection2.imports(Math.cos, Math.sin)
    })

    it(`consistent identity`, async () => {
      const func = async (a, b) => a + b
      const exports = [func, func]
      const { close, imports } = await serialize(exports)
      const [left, right] = imports
      expect(left).toBe(right)
      close()
    })

    it(`throws exception`, async () => {
      const exports = async () => {
        throw new Error(`a tantrum`)
      }

      const { close, imports } = await serialize(exports)
      await expectAsync(imports()).toBeRejected()
      close()
    })
  })

  it(`map`, async () => {
    const exports = new Map([[`a`, 1], [`b`, 2], [`c`, 3]])
    const { close, imports } = await serialize(exports)
    expect(imports).toEqual(exports)
    close()
  })

  it(`null`, async () => {
    const exports = null
    const { close, imports } = await serialize(exports)
    expect(imports).toEqual(exports)
    close()
  })

  it(`number`, async () => {
    const exports = 42
    const { close, imports } = await serialize(exports)
    expect(imports).toEqual(exports)
    close()
  })

  it(`object`, async () => {
    const exports = { a: 1, b: 2, c: 3 }
    const { close, imports } = await serialize(exports)
    expect(imports).toEqual(exports)
    close()
  })

  it(`set`, async () => {
    const exports = new Set([1, 2, 3])
    const { close, imports } = await serialize(exports)
    expect(imports).toEqual(exports)
    close()
  })

  it(`undefined`, async () => {
    const exports = undefined
    const { close, imports } = await serialize(exports)
    expect(imports).toEqual(exports)
    close()
  })

  it(`unsupported`, async () => {
    const { a } = createMockRealms()
    const exports = Symbol(`description`)

    expectAsync(
      Connection({
        exports,
        input: a,
        output: a,
        outputOrigin: `a`
      })
    ).toBeRejected()
  })
})
