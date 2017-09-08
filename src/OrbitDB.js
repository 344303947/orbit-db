'use strict'

const EventEmitter  = require('events').EventEmitter
const EventStore    = require('orbit-db-eventstore')
const FeedStore     = require('orbit-db-feedstore')
const KeyValueStore = require('orbit-db-kvstore')
const CounterStore  = require('orbit-db-counterstore')
const DocumentStore = require('orbit-db-docstore')
const Pubsub        = require('orbit-db-pubsub')
const Cache = require('orbit-db-cache')
const path = require('path')
const parseAddress = require('./parse-address')

const defaultNetworkName = 'Orbit DEV Network'

class OrbitDB {
  constructor(ipfs, id = 'default', options = {}) {
    this._ipfs = ipfs
    this._pubsub = options && options.broker ? new options.broker(ipfs) : new Pubsub(ipfs, id)
    this.user = { id: id }
    this.network = { name: defaultNetworkName }
    this.events = new EventEmitter()
    this.stores = {}
    this.types = ['eventlog', 'feed', 'docstore', 'counter', 'keyvalue']
  }

  /* Databases */
  feed(dbname, options) {
    return this._createStore(FeedStore, dbname, options)
  }

  eventlog(dbname, options) {
    return this._createStore(EventStore, dbname, options)
  }

  kvstore(dbname, options) {
    return this._createStore(KeyValueStore, dbname, options)
  }

  counter(dbname, options) {
    return this._createStore(CounterStore, dbname, options)
  }

  docstore(dbname, options) {
    return this._createStore(DocumentStore, dbname, options)
  }

  close(dbname) {
    if(this._pubsub) this._pubsub.unsubscribe(dbname)
    if (this.stores[dbname]) {
      this.stores[dbname].events.removeAllListeners('write')
      delete this.stores[dbname]
    }
  }

  disconnect() {
    Object.keys(this.stores).forEach((e) => this.close(e))
    if (this._pubsub) this._pubsub.disconnect()
    this.stores = {}
    this.user = null
    this.network = null
  }

  create (address, type, directory, options) {
    const p = path.join(directory || './orbitdb')
    const addr = OrbitDB.parseAddress(address, this.user.id)
    this._cache = new Cache(p, addr.indexOf('/orbitdb') === 0 ? addr.replace('/orbitdb', '') : addr)
    options = Object.assign({}, options, { path: p, cache: this._cache })
    return this._cache.load()
      .then(() => this._cache.get(addr))
      .then((hash) => {
        if (hash) 
          throw new Error(`Database '${addr}' already exists!`)

          if (!OrbitDB.isValidType(this.types, type))
            throw new Error(`Invalid database type '${type}'.`)
      })
      .then(() => this._cache.set(addr + '.type', type))
      .then(() => this._cache.set(addr + '.localhead', null))
      .then(() => this._cache.set(addr + '.remotehead', null))
      .then(() => this._openDatabase(addr, type, options))
  }

  load (address, directory, options) {
    const p = path.join(directory || './orbitdb')
    const addr = OrbitDB.parseAddress(address, this.user.id)
    this._cache = new Cache(p, addr.indexOf('/orbitdb') === 0 ? addr.replace('/orbitdb', '') : addr)
    options = Object.assign({}, options, { path: p, cache: this._cache })
    return this._cache.load()
      .then(() => this._cache.get(addr + '.type'))
      .then((type) => {
        options.type
        if (!type && !options.type)
          throw new Error(`Database '${addr}' doesn't exist.`)
        else if (options.type && options.create === true)
          return this.create(address, options.type, directory, options)
        else
          this._openDatabase(addr, type, options)
      })
  }

  _openDatabase (dbname, type, options) {
    if (type === 'counter')
      return this.counter(dbname, options)
    else if (type === 'eventlog')
      return this.eventlog(dbname, options)
    else if (type === 'feed')
      return this.feed(dbname, options)
    else if (type === 'docstore')
      return this.docstore(dbname, options)
    else if (type === 'keyvalue')
      return this.kvstore(dbname, options)
    else
      throw new Error(`Unknown database type '${type}'`)
  }

  /* Private methods */
  _createStore(Store, dbname, options) {
    const opts = Object.assign({ replicate: true }, options)

    const addr = OrbitDB.parseAddress(dbname, this.user.id)
    const store = new Store(this._ipfs, this.user.id, dbname, opts)
    store.events.on('write', this._onWrite.bind(this))
    store.events.on('ready', this._onReady.bind(this))

    this.stores[addr] = store

    if(opts.replicate && this._pubsub)
      this._pubsub.subscribe(addr, this._onMessage.bind(this))

    return store
  }

  // Callback for receiving a message from the network
  _onMessage(dbname, heads) {
    const store = this.stores[dbname]
    store.sync(heads)
  }

  // Callback for local writes to the database. We the update to pubsub.
  _onWrite(dbname, hash, entry, heads) {
    if(!heads) throw new Error("'heads' not defined")
    if(this._pubsub) setImmediate(() => this._pubsub.publish(dbname, heads))
  }

  // Callback for database being ready
  _onReady(dbname, heads) {
    if(heads && this._pubsub) {
      setTimeout(() => this._pubsub.publish(dbname, heads), 1000)
    }
  }

  static isValidType (types, type) {
    return types.includes(type)
  }

  static parseAddress (address, id) {
    return parseAddress(address, id)
  }
}

module.exports = OrbitDB
