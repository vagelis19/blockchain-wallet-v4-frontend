import {
  compose,
  curry,
  range,
  keysIn,
  isNil,
  pluck,
  filter,
  propEq,
  uniq
} from 'ramda'
import { networks } from 'bitcoinjs-lib'

import * as T from '../actionTypes'
import { Wrapper, Wallet, HDAccount } from '../../types'
import * as selectors from '../selectors'

/**
 * Number of addresses for each HD Account to sync with platform
 * This includes labeled addresses and future ones
 * Labaled addreses have higher priority
 */
export const addressLookaheadCount = 10

export const toAsync = fn =>
  new Promise(resolve => setTimeout(() => resolve(fn()), 0))

/**
 * Launches derivation of future addresses for target HDAccount
 * @curried
 * @param {any} state redux state
 * @param {HDAccount.HDAccount} account
 * @returns {Promise<String>[]} array of promises, each of them resolves into address
 */
export const getHDAccountAddressPromises = curry((state, account) => {
  const xpub = selectors.wallet.getAccountXpub(account.index, state)

  /**
   * Get each address within separate event queue entry
   * in order to unblock the UI during heavy scripting
   * setTimeout runs infrequently and is less blocking
   * requestAnimation frame blocks UI heavier
   */
  const asyncDerive = index =>
    toAsync(() =>
      HDAccount.getReceiveAddress(account, index, networks.bitcoin.NETWORK_BTC)
    )

  const receiveIndex = selectors.data.bitcoin
    .getReceiveIndex(xpub, state)
    .getOrElse(null)
  if (isNil(receiveIndex)) return []

  return range(receiveIndex, receiveIndex + addressLookaheadCount).map(
    asyncDerive
  )
})

/**
 * getWalletAddresses :: (state, api) -> Promise<String[]>
 */
export const getUnusedLabeledAddresses = async (state, api) => {
  const labeledAddresses = await api.fetchBlockchainData(
    selectors.kvStore.btc.getAddressLabels(state)
  )
  return compose(
    pluck('address'),
    filter(propEq('n_tx', 0))
  )(labeledAddresses.addresses)
}

/**
 * Collects all of the wallet active addresses:
 *   regular, hd and labeled
 * getWalletAddresses :: (state, api) -> Promise<String[]>
 */
export const getWalletAddresses = async (state, api) => {
  const activeAddresses = keysIn(selectors.wallet.getActiveAddresses(state))
  const hdAccounts = compose(
    Wallet.selectHDAccounts,
    selectors.wallet.getWallet
  )(state)
  const [unusedAddresses, ...hdAddresses] = await Promise.all([
    getUnusedLabeledAddresses(state, api),
    ...hdAccounts.flatMap(getHDAccountAddressPromises(state)).toJS()
  ])

  return activeAddresses.concat(uniq(hdAddresses.concat(unusedAddresses)))
}

export const shouldSync = ({
  actionType,
  newAuthenticated,
  newWallet,
  oldAuthenticated,
  oldWallet
}) =>
  actionType === T.walletSync.FORCE_SYNC ||
  (oldAuthenticated &&
    newAuthenticated &&
    actionType !== T.wallet.SET_PAYLOAD_CHECKSUM &&
    actionType !== T.wallet.REFRESH_WRAPPER &&
    // Easily know when to sync, because of ✨immutable✨ data
    // the initial_state check could be done against full payload state
    oldWallet !== newWallet)

/**
 * Wallet sync middleware
 * Calls sync on special conditions
 *
 * TODO: refactor to sagas, VERY painful to test/write mocks
 */
const walletSync = ({
  isAuthenticated,
  rootDocumentDispatch
} = {}) => store => next => action => {
  const oldState = store.getState()
  const result = next(action)
  const newState = store.getState()
  const newWallet = selectors.wallet.getWrapper(newState)

  if (
    shouldSync({
      actionType: action.type,
      newAuthenticated: isAuthenticated(newState),
      newWallet,
      oldAuthenticated: isAuthenticated(oldState),
      oldWallet: selectors.wallet.getWrapper(oldState)
    })
  ) {
    rootDocumentDispatch({
      type: T.wallet.MERGE_WRAPPER,

      // Convert the wallet to JavaScript types so it can cross the realm
      // boundary.
      payload: Wrapper.toJS(newWallet)
    })
  }

  return result
}

export default walletSync
