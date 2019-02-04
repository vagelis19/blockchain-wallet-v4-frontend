// Multiplex `postMessage` and the `message` event so that multiple agents can
// share the communication channel between realms.
export default ({ realm, tag }) => {
  const listeners = new Map()

  return {
    addEventListener: (event, listener, useCapture = false) => {
      // Multiplex only message events.
      if (event === `message`) {
        const multiplexListener = ({ data }) => {
          // Listen only to appropriately tagged messages and ignore the rest.
          if (data.type === tag) {
            return listener({ data: data.data })
          }
        }

        // Remember this listener so that we can remove it later.
        listeners.set(listener, multiplexListener)

        return realm.addEventListener(`message`, multiplexListener, useCapture)
      } else {
        return realm.addEventListener(event, listener, useCapture)
      }
    },

    postMessage: (message, targetOrigin) =>
      realm.postMessage({ type: tag, data: message }, targetOrigin),

    removeEventListener: (event, listener) => {
      if (event === `message`) {
        const result = realm.removeEventListener(event, listeners.get(listener))
        listeners.delete(listener)
        return result
      } else {
        return realm.removeEventListener(event, listener)
      }
    }
  }
}
