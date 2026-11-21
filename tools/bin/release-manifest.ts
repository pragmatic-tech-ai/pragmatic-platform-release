import { ReleaseManifestCli } from '../release-manifest.js'

ReleaseManifestCli.Run(process.argv.slice(2), process.env, {
    Out: line => console.log(line),
    Err: line => console.error(line),
}).then(code => { process.exitCode = code })
