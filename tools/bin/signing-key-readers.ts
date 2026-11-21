import { SigningKeyReadersCli } from '../signing-key-readers.js'

SigningKeyReadersCli.Run(process.env, {
    Out: line => console.log(line),
    Err: line => console.error(line),
}).then(code => { process.exitCode = code })
