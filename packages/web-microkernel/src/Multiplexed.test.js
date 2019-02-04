import Multiplexed from './Multiplexed.js'

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
      console.log(`postMessage`, message)
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

it(`multiplexes use of a realm with a wrapper`, async () => {
  const { a, b } = createMockRealms()

  const sender1 = Multiplexed({ realm: a, tag: `multiplexed 1` })
  const sender2 = Multiplexed({ realm: a, tag: `multiplexed 2` })
  const receiver1 = Multiplexed({ realm: b, tag: `multiplexed 1` })
  const receiver2 = Multiplexed({ realm: b, tag: `multiplexed 2` })

  let reject1
  let resolve1
  let reject2
  let resolve2

  const listener1 = ({ data }) => {
    try {
      expect(data).toEqual(`multiplexed 1`)
      resolve1()
    } catch (exception) {
      reject1(exception)
    }
  }

  const listener2 = ({ data }) => {
    try {
      expect(data).toEqual(`multiplexed 2`)
      resolve2()
    } catch (exception) {
      reject2(exception)
    }
  }

  const promises = Promise.all([
    new Promise((resolve, reject) => {
      resolve1 = resolve
      reject1 = reject
    }),
    new Promise((resolve, reject) => {
      resolve2 = resolve
      reject2 = reject
    })
  ])

  receiver1.addEventListener(`message`, listener1)
  receiver2.addEventListener(`message`, listener2)
  sender1.postMessage(`multiplexed 1`, `a`)
  sender2.postMessage(`multiplexed 2`, `a`)
  await promises
  receiver1.removeEventListener(`message`, listener1)
  receiver2.removeEventListener(`message`, listener2)
})
