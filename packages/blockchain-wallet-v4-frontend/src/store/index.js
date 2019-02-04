import axios from 'axios'
import Channel from '@nodeguy/channel'
import { createStore, applyMiddleware, compose } from 'redux'
import createSagaMiddleware from 'redux-saga'
import { persistStore, persistCombineReducers } from 'redux-persist'
import { RealmConnection, Multiplexed } from '../../../web-microkernel/src'
import storage from 'redux-persist/lib/storage'
import getStoredStateMigrateV4 from 'redux-persist/lib/integration/getStoredStateMigrateV4'
import { createHashHistory } from 'history'
import { connectRouter, routerMiddleware } from 'connected-react-router'
import { dissoc, dissocPath, head, omit } from 'ramda'
import Bitcoin from 'bitcoinjs-lib'
import BitcoinCash from 'bitcoinforksjs-lib'

import { coreMiddleware } from 'blockchain-wallet-v4/src'
import {
  SYNC_ERROR,
  SYNC_SUCCESS
} from 'blockchain-wallet-v4/src/redux/walletSync/actionTypes'
import {
  createWalletApi,
  Socket,
  ApiSocket,
  HorizonStreamingService
} from 'blockchain-wallet-v4/src/network'
import { serializer } from 'blockchain-wallet-v4/src/types'
import { actions, rootSaga, rootReducer, selectors } from 'data'
import {
  autoDisconnection,
  forwardActions,
  streamingXlm,
  webSocketBch,
  webSocketBtc,
  webSocketEth,
  webSocketRates
} from '../middleware'

const devToolsConfig = {
  maxAge: 1000,
  name: `Root Document`,
  serialize: serializer,
  actionsBlacklist: [
    // '@@redux-form/INITIALIZE',
    // '@@redux-form/CHANGE',
    // '@@redux-form/REGISTER_FIELD',
    // '@@redux-form/UNREGISTER_FIELD',
    // '@@redux-form/UPDATE_SYNC_ERRORS',
    // '@@redux-form/FOCUS',
    // '@@redux-form/BLUR',
    // '@@redux-form/DESTROY',
    // '@@redux-form/RESET'
  ]
}

const configureStore = async () => {
  const history = createHashHistory()
  const sagaMiddleware = createSagaMiddleware()
  const composeEnhancers = window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__
    ? window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__(devToolsConfig)
    : compose
  const walletPath = 'wallet.payload'
  const kvStorePath = 'wallet.kvstore'
  const isAuthenticated = selectors.auth.isAuthenticated

  const options = await (await fetch(
    '/Resources/wallet-options-v4.json'
  )).json()

  const apiKey = '1770d5d9-bcea-4d28-ad21-6cbd5be018a8'
  // TODO: deprecate when wallet-options-v4 is updated on prod
  const socketUrl = head(options.domains.webSocket.split('/inv'))
  const horizonUrl = options.domains.horizon
  const btcSocket = new Socket({
    options,
    url: `${socketUrl}/inv`
  })
  const bchSocket = new Socket({
    options,
    url: `${socketUrl}/bch/inv`
  })
  const ethSocket = new Socket({
    options,
    url: `${socketUrl}/eth/inv`
  })
  const ratesSocket = new ApiSocket({
    options,
    url: `${socketUrl}/nabu-gateway/markets/quotes`,
    maxReconnects: 3
  })
  const xlmStreamingService = new HorizonStreamingService({
    url: horizonUrl
  })

  // Omit properties that can't be serialized.
  const sanitizedAxios = async config => {
    try {
      const returnValue = await axios(config)
      const sanitizedReturnValue = omit([`config`, `request`], returnValue)
      return sanitizedReturnValue
    } catch (exception) {
      const sanitizedException = dissocPath(
        [`response`, `request`],
        dissoc(`request`, exception)
      )

      throw Object.assign(Error(exception.message), sanitizedException)
    }
  }

  // The store isn't available by the time we want to export its dispatch method
  // so use a channel to hold pending actions.
  const actionsChannel = Channel()

  const mainProcessWindow = document.getElementById(`main-process`)
    .contentWindow

  const mainProcess = await RealmConnection({
    exports: { axios: sanitizedAxios, dispatch: actionsChannel.push },
    input: Multiplexed({ realm: window, tag: `realms` }),
    output: Multiplexed({ realm: mainProcessWindow, tag: `realms` }),
    outputOrigin: options.domains.mainProcess
  })

  mainProcess.addEventListener(`error`, console.error)

  const getAuthCredentials = () =>
    selectors.modules.profile.getAuthCredentials(store.getState())
  const reauthenticate = () => store.dispatch(actions.modules.profile.signIn())
  const networks = {
    btc: Bitcoin.networks[options.platforms.web.btc.config.network],
    bch: BitcoinCash.networks[options.platforms.web.btc.config.network],
    bsv: BitcoinCash.networks[options.platforms.web.btc.config.network],
    eth: options.platforms.web.eth.config.network,
    xlm: options.platforms.web.xlm.config.network
  }
  const api = createWalletApi({
    options,
    apiKey,
    getAuthCredentials,
    reauthenticate,
    networks
  })
  const persistWhitelist = ['session', 'preferences', 'cache']

  // Forward the following action types to the main process.
  //
  // @CORE.SYNC_ERROR:  Report failure of wallet synchronization.
  // @CORE.SYNC_SUCCESS:  Report success of wallet synchronization.
  const forwardActionTypes = new Set([SYNC_ERROR, SYNC_SUCCESS])

  // TODO: remove getStoredStateMigrateV4 someday (at least a year from now)
  const store = createStore(
    connectRouter(history)(
      persistCombineReducers(
        {
          getStoredState: getStoredStateMigrateV4({
            whitelist: persistWhitelist
          }),
          key: 'root',
          storage,
          whitelist: persistWhitelist
        },
        rootReducer
      )
    ),
    composeEnhancers(
      applyMiddleware(
        sagaMiddleware,
        routerMiddleware(history),
        coreMiddleware.kvStore({ isAuthenticated, api, kvStorePath }),
        webSocketBtc(btcSocket),
        webSocketBch(bchSocket),
        webSocketEth(ethSocket),
        streamingXlm(xlmStreamingService, api),
        webSocketRates(ratesSocket),
        coreMiddleware.walletSync({ isAuthenticated, api, walletPath }),
        autoDisconnection(),

        forwardActions({
          forward: mainProcess.imports.dispatch,
          types: forwardActionTypes
        })
      )
    )
  )
  const persistor = persistStore(store, null)

  sagaMiddleware.run(rootSaga, {
    api,
    bchSocket,
    btcSocket,
    ethSocket,
    ratesSocket,
    networks,
    options
  })

  // Now that we have a store, dispatch pending and future actions from the
  // channel.
  actionsChannel.forEach(store.dispatch)

  // expose globals here
  window.createTestXlmAccounts = () => {
    store.dispatch(actions.core.data.xlm.createTestAccounts())
  }

  store.dispatch(actions.goals.defineGoals())

  return {
    store,
    history,
    persistor
  }
}

export default configureStore
