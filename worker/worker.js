"use strict";

const _ = require('lodash');
const fs = require('fs');
const grpc = require('grpc');
const config = require('config');
const uuid = require('uuid');
const async = require('async');
const bunyan = require('bunyan');
const rpc = require('./workerrpc');
const mr = require('../lib/mapreduce');
const errors = require('../lib/errors');

const MASTER_PROTO_PATH = "./protos/master.proto";
const WORKER_PROTO_PATH = "./protos/worker.proto";

class Worker {
  /**
   * Create a Worker instance
   * @param {string} workerAddr - worker address with format ipaddress:port
   * @param {string} masterAddr - master address with format ipaddress:port
   */
  constructor(workerAddr, masterAddr) {
    this.workerId = uuid.v4();
    this.workerAddr = workerAddr;
    this.masterAddr = masterAddr;
    this.nMap = null;
    this.nReduce = null;

    this.masterDescriptor = grpc.load(config.get("proto.master")).masterrpc;
    this.workerDescriptor = grpc.load(config.get("proto.worker")).workerrpc;

    // logger
    this.log = bunyan.createLogger({
      name: `worker ${this.workerId}`,
      level: config.get('logger.level'),
    });

    // load master rpc service
    this.master = new this.masterDescriptor.Master(masterAddr, grpc.credentials.createInsecure());

    // create worker rpc server
    this.server = new grpc.Server();
    this.server.bind(workerAddr, grpc.ServerCredentials.createInsecure());

    // add rpc functions
    this.server.addProtoService(this.workerDescriptor.Worker.service, {
      ping: rpc.ping.bind(this),
      doJob: rpc.doJob.bind(this),
      getInterKeyValues: rpc.getInterKeyValues.bind(this),
      getReducerOutput: rpc.getReducerOutput.bind(this),
    });
  }


  // ---- Worker private functions ----

  // register worker with master
  _register() {
    const data = {
      worker_id: this.workerId,
      worker_address: this.workerAddr 
    };
    this.master.register(data, (err, resp) => {
      if (err) {
        this.log.error(err);
        process.exit(2);
      }
      if (!resp) {
        this.log.error(errors.noResponseFromMaster());
        process.exit(2);
      }
      if (!resp.ok || resp.ok != true) {
        this.log.error(errors.notOkResponse());
        process.exit(2);
      }
      if (!_.isInteger(resp.n_map) || !_.isInteger(resp.n_reduce) || 
        resp.n_map <= 0 || resp.n_reduce <= 0) {
        this.log.error(errors.invalidValues());
        process.exit(2);
      }
      this.nMap = resp.n_map;
      this.nReduce = resp.n_reduce;
      this.log.info(`Connected with master at ${this.masterAddr}`);
    });
  }

  // hashes a string and returns an integer
  _hashCode(s) {
    let hash = 0;
    let char;
    let i, l;
    if (s.length === 0) {
      return hash;
    }
    for (i = 0, l = s.length; i < l; i++) {
      char = s.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  _doMapByRpcStream(jobNum, fileName) {
    this.log.info(`Working on map ${jobNum}`);
    const data = {
      worker_id: this.workerId,
      job_number: jobNum,
    };
    const rpcStream = this.master.getMapSplit(data);
    let keyValues = [];
    rpcStream.on('data', (split) => {
      // TODO: improve efficiency of this by piping to a transformer stream instead of storing key values in memory
      keyValues = keyValues.concat(mr.mapFunc(fileName, split.line));
    });
    rpcStream.on('end', () => {
      // write to appropriate reducer file stream
      const streams = [];
      for (let i = 0; i < this.nReduce; i++) {
        const writeStream = fs.createWriteStream(mr.reduceFileName(fileName, jobNum, i));
        streams.push(writeStream);
      }
      keyValues.forEach((kv) => {
        const reduceNum = this._hashCode(Object.keys(kv)[0]) % this.nReduce;
        streams[reduceNum].write(JSON.stringify(kv) + '\n');
      });
      // end all write streams
      streams.forEach((s) => {
        s.end();
      });
      // signal to master this map job is done
      const data = {
        worker_id: this.workerId,
        job_number: jobNum,
        operation: mr.OP.MAP,
        error: ""
      };
      this.master.jobDone(data, (err, resp) => {
        if (err) {
          this.log.error(err);
          // TODO: retry instead of exiting
          process.exit(2);
        }
        if (!resp) {
          this.log.error(errors.noResponseFromMaster());
          // TODO: retry instead of exiting
          process.exit(2);
        }
        this.log.info(`Map job ${jobNum} done`);
      });
    });
  }

  _doReduceByRpcStream(jobNum, fileName) {
    this.log.info(`working on reduce ${jobNum}`);
    this.master.getWorkerInfo({}, (err, resp) => {
      if (err) {
        this.log.error(err);
        // TODO: handle error gracefully
        process.exit(2);
      }
      const mapperAddrs = resp.mapper_addresses;
      // iterate through all map jobs for this reducer
      const tasks = [];
      const kvs = {};
      for (let mapJobNum = 0; mapJobNum < this.nMap; mapJobNum++) {
        // TODO: check if mapper is ready for transfer
        tasks.push((callback) => {
          const mapper = new this.workerDescriptor.Worker(mapperAddrs[mapJobNum], grpc.credentials.createInsecure());
          const data = {
            mapper_number: mapJobNum,
            reducer_number: jobNum,
            file_name: fileName,
          };
          const rpcStream = mapper.getInterKeyValues(data);
          rpcStream.on('data', (chunk) => {
            // skip invalid strings
            if (!chunk.key_value) {
              return;
            }
            const interKv = JSON.parse(chunk.key_value);
            const key = Object.keys(interKv)[0];
            const value = interKv[key];
            if (!kvs[key]) {
              kvs[key] = [value];
            } else {
              kvs[key].push(value);
            }
          });
          rpcStream.on('end', callback);
        });
      }
      async.parallel(tasks, (err) => {
        // TODO: handle err properly
        // sort the keys and run reducer function
        const writeStream = fs.createWriteStream(mr.mergeFileName(fileName, jobNum));
        const sortedKeys = Object.keys(kvs).sort();
        sortedKeys.forEach((key) => {
          const res = mr.reduceFunc(key, kvs[key]);
          const kv = {};
          kv[key] = res;
          writeStream.write(JSON.stringify(kv) + '\n');
        });
        writeStream.end();
        // signal to master this reduce job is done
        const data = {
          worker_id: this.workerId,
          job_number: jobNum,
          operation: mr.OP.REDUCE,
          error: err ? err.message : ""
        };
        this.master.jobDone(data, (err, resp) => {
          if (err) {
            this.log.error(err);
            process.exit(2);
          }
          if (!resp) {
            this.log.error(errors.noResponseFromMaster());
            process.exit(2);
          }
          this.log.info(`Reduce job ${jobNum} done`);
        });
      });
    });
  }

  // ---- Worker public functions

  // run the worker
  start() {
    this.server.start();
    this._register();
    this.log.info(`Worker ${this.workerId} running at ${this.workerAddr}`);
  }
}

exports.Worker = Worker;