import { FORWARD } from './actionTypes'

export default ({ forward, types }) => () => next => action => {
  if (types.has(action.type)) {
    forward(action)
  } else if (action.type === FORWARD) {
    forward(action.payload)
  }

  return next(action)
}
