import { expect } from 'chai'
import * as childProcess from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as multiparty from 'multiparty'
import * as path from 'path'
import { ifdescribe, ifit } from './spec-helpers'
import * as temp from 'temp'
import * as url from 'url'
import { ipcMain, app, BrowserWindow, crashReporter, BrowserWindowConstructorOptions } from 'electron'
import { AddressInfo } from 'net'
import { closeWindow, closeAllWindows } from './window-helpers'
import { EventEmitter } from 'events'

temp.track()

const afterTest: ((() => void) | (() => Promise<void>))[] = []
async function cleanup() {
  for (const cleanup of afterTest) {
    const r = cleanup()
    if (r instanceof Promise)
      await r
  }
  afterTest.length = 0
}

// TODO(alexeykuzmin): [Ch66] This test fails on Linux. Fix it and enable back.
ifdescribe(!process.mas && !process.env.DISABLE_CRASH_REPORTER_TESTS && process.platform !== 'linux')('crashReporter module', function () {
  let originalTempDirectory: string
  let tempDirectory = null
  const fixtures = path.resolve(__dirname, '..', 'spec', 'fixtures')

  before(() => {
    tempDirectory = temp.mkdirSync('electronCrashReporterSpec-')
    originalTempDirectory = app.getPath('temp')
    app.setPath('temp', tempDirectory)
  })

  after(() => {
    app.setPath('temp', originalTempDirectory)
    try {
      temp.cleanupSync()
    } catch (e) {
      // ignore.
      console.warn(e.stack)
    }
  })

  afterEach(cleanup)

  it('should send minidump when node processes crash', async () => {
    const { port, waitForCrash } = await startServer()

    const crashesDir = path.join(app.getPath('temp'), `${app.name} Crashes`)
    const version = app.getVersion()
    const crashPath = path.join(fixtures, 'module', 'crash.js')
    childProcess.fork(crashPath, [port.toString(), version, crashesDir], { silent: true })
    const crash = await waitForCrash()
    checkCrash('node', crash)
  })

  const generateSpecs = (description: string, browserWindowOpts: BrowserWindowConstructorOptions) => {
    describe(description, () => {
      let w: BrowserWindow

      beforeEach(() => {
        w = new BrowserWindow(Object.assign({ show: false }, browserWindowOpts))
      })

      afterEach(async () => {
        await closeWindow(w)
        w = null as unknown as BrowserWindow
      })

      it('should send minidump when renderer crashes', async () => {
        const { port, waitForCrash } = await startServer()
        w.loadFile(path.join(fixtures, 'api', 'crash.html'), { query: { port: port.toString() } })
        const crash = await waitForCrash()
        checkCrash('renderer', crash)
      })

      ifit(!browserWindowOpts.webPreferences!.sandbox)('should send minidump when node processes crash', async function () {
        const { port, waitForCrash } = await startServer()
        const crashesDir = path.join(app.getPath('temp'), `${app.name} Crashes`)
        const version = app.getVersion()
        const crashPath = path.join(fixtures, 'module', 'crash.js')
        w.loadFile(path.join(fixtures, 'api', 'crash_child.html'), { query: { port: port.toString(), crashesDir, crashPath, version } })
        const crash = await waitForCrash()
        expect(String((crash as any).newExtra)).to.equal('newExtra')
        expect((crash as any).removeExtra).to.be.undefined()
        checkCrash('node', crash)
      })

      describe('when uploadToServer is false', () => {
        after(() => { crashReporter.setUploadToServer(true) })

        it('should not send minidump', async () => {
          const { port, getCrashes } = await startServer()
          crashReporter.setUploadToServer(false)

          let crashesDir = crashReporter.getCrashesDirectory()
          const existingDumpFiles = new Set()
          // crashpad puts the dump files in the "completed" subdirectory
          if (process.platform === 'darwin') {
            crashesDir = path.join(crashesDir, 'completed')
          } else {
            crashesDir = path.join(crashesDir, 'reports')
          }

          const crashUrl = url.format({
            protocol: 'file',
            pathname: path.join(fixtures, 'api', 'crash.html'),
            search: `?port=${port}&skipUpload=1`
          })
          w.loadURL(crashUrl)

          await new Promise(resolve => {
            ipcMain.once('list-existing-dumps', (event) => {
              fs.readdir(crashesDir, (err, files) => {
                if (!err) {
                  for (const file of files) {
                    if (/\.dmp$/.test(file)) {
                      existingDumpFiles.add(file)
                    }
                  }
                }
                event.returnValue = null // allow the renderer to crash
                resolve()
              })
            })
          })

          const dumpFileCreated = async () => {
            async function getDumps() {
              const files = await fs.promises.readdir(crashesDir)
              return files.filter((file) => /\.dmp$/.test(file) && !existingDumpFiles.has(file))
            }
            for (let i = 0; i < 30; i++) {
              const dumps = await getDumps()
              if (dumps.length) {
                return path.join(crashesDir, dumps[0])
              }
              await new Promise(resolve => setTimeout(resolve, 1000))
            }
          }

          const dumpFile = await dumpFileCreated()
          expect(dumpFile).to.be.a('string')

          // dump file should not be deleted when not uploading, so we wait
          // 1s and assert it still exists
          await new Promise(resolve => setTimeout(resolve, 1000))
          expect(fs.existsSync(dumpFile!)).to.be.true()

          // the server should not have received any crashes.
          expect(getCrashes()).to.be.empty()
        })
      })

      it('should send minidump with updated extra parameters', async function () {
        const { port, waitForCrash } = await startServer()

        const crashUrl = url.format({
          protocol: 'file',
          pathname: path.join(fixtures, 'api', 'crash-restart.html'),
          search: `?port=${port}`
        })
        w.loadURL(crashUrl)
        const crash = await waitForCrash()
        checkCrash('renderer', crash)
      })
    })
  }

  generateSpecs('without sandbox', {
    webPreferences: {
      nodeIntegration: true
    }
  })
  generateSpecs('with sandbox', {
    webPreferences: {
      sandbox: true,
      preload: path.join(fixtures, 'module', 'preload-sandbox.js')
    }
  })

  describe('start(options)', () => {
    it('requires that the companyName and submitURL options be specified', () => {
      expect(() => {
        crashReporter.start({ companyName: 'Missing submitURL' } as any)
      }).to.throw('submitURL is a required option to crashReporter.start')
      expect(() => {
        crashReporter.start({ submitURL: 'Missing companyName' } as any)
      }).to.throw('companyName is a required option to crashReporter.start')
    })
    it('can be called multiple times', () => {
      expect(() => {
        crashReporter.start({
          companyName: 'Umbrella Corporation',
          submitURL: 'http://127.0.0.1/crashes'
        })

        crashReporter.start({
          companyName: 'Umbrella Corporation 2',
          submitURL: 'http://127.0.0.1/more-crashes'
        })
      }).to.not.throw()
    })
  })

  describe('getCrashesDirectory', () => {
    it('correctly returns the directory', () => {
      const crashesDir = crashReporter.getCrashesDirectory()
      const dir = path.join(app.getPath('temp'), 'Electron Test Main Crashes')
      expect(crashesDir).to.equal(dir)
    })
  })

  describe('getUploadedReports', () => {
    it('returns an array of reports', () => {
      const reports = crashReporter.getUploadedReports()
      expect(reports).to.be.an('array')
    })
  })

  // TODO(alexeykuzmin): This suite should explicitly
  // generate several crash reports instead of hoping
  // that there will be enough of them already.
  describe('getLastCrashReport', () => {
    it('correctly returns the most recent report', () => {
      const reports = crashReporter.getUploadedReports()
      expect(reports).to.be.an('array')
      expect(reports).to.have.lengthOf.at.least(2,
        'There are not enough reports for this test')

      const lastReport = crashReporter.getLastCrashReport()
      expect(lastReport).to.be.an('object')
      expect(lastReport.date).to.be.an.instanceOf(Date)

      // Let's find the newest report.
      const { report: newestReport } = reports.reduce((acc, cur) => {
        const timestamp = new Date(cur.date).getTime()
        return (timestamp > acc.timestamp)
          ? { report: cur, timestamp: timestamp }
          : acc
      }, { timestamp: -Infinity } as { timestamp: number, report?: any })
      expect(newestReport).to.be.an('object')

      expect(lastReport.date.getTime()).to.be.equal(
        newestReport.date.getTime(),
        'Last report is not the newest.')
    })
  })

  describe('getUploadToServer()', () => {
    it('returns true when uploadToServer is set to true', function () {
      crashReporter.start({
        companyName: 'Umbrella Corporation',
        submitURL: 'http://127.0.0.1/crashes',
        uploadToServer: true
      })
      expect(crashReporter.getUploadToServer()).to.be.true()
    })
    it('returns false when uploadToServer is set to false', function () {
      crashReporter.start({
        companyName: 'Umbrella Corporation',
        submitURL: 'http://127.0.0.1/crashes',
        uploadToServer: true
      })
      crashReporter.setUploadToServer(false)
      expect(crashReporter.getUploadToServer()).to.be.false()
    })
  })

  describe('setUploadToServer(uploadToServer)', () => {
    afterEach(closeAllWindows)
    it('throws an error when called from the renderer process', async () => {
      const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true } })
      w.loadURL('about:blank')
      await expect(
        w.webContents.executeJavaScript(`require('electron').crashReporter.setUploadToServer(true)`)
      ).to.eventually.be.rejected()
      await expect(
        w.webContents.executeJavaScript(`require('electron').crashReporter.getUploadToServer()`)
      ).to.eventually.be.rejected()
    })
    it('sets uploadToServer false when called with false', function () {
      crashReporter.start({
        companyName: 'Umbrella Corporation',
        submitURL: 'http://127.0.0.1/crashes',
        uploadToServer: true
      })
      crashReporter.setUploadToServer(false)
      expect(crashReporter.getUploadToServer()).to.be.false()
    })
    it('sets uploadToServer true when called with true', function () {
      crashReporter.start({
        companyName: 'Umbrella Corporation',
        submitURL: 'http://127.0.0.1/crashes',
        uploadToServer: false
      })
      crashReporter.setUploadToServer(true)
      expect(crashReporter.getUploadToServer()).to.be.true()
    })
  })

  describe('Parameters', () => {
    it('returns all of the current parameters', () => {
      crashReporter.start({
        companyName: 'Umbrella Corporation',
        submitURL: 'http://127.0.0.1/crashes'
      })

      const parameters = crashReporter.getParameters()
      expect(parameters).to.be.an('object')
    })
    it('adds a parameter to current parameters', function () {
      crashReporter.start({
        companyName: 'Umbrella Corporation',
        submitURL: 'http://127.0.0.1/crashes'
      })

      crashReporter.addExtraParameter('hello', 'world')
      expect(crashReporter.getParameters()).to.have.property('hello')
    })
    it('removes a parameter from current parameters', function () {
      crashReporter.start({
        companyName: 'Umbrella Corporation',
        submitURL: 'http://127.0.0.1/crashes'
      })

      crashReporter.addExtraParameter('hello', 'world')
      expect(crashReporter.getParameters()).to.have.property('hello')

      crashReporter.removeExtraParameter('hello')
      expect(crashReporter.getParameters()).to.not.have.property('hello')
    })
  })

  describe('when not started', () => {
    it('does not prevent process from crashing', (done) => {
      const appPath = path.join(fixtures, 'api', 'cookie-app')
      const appProcess = childProcess.spawn(process.execPath, [appPath])
      appProcess.once('close', () => {
        done()
      })
    })
  })
})

type CrashInfo = {
  prod: string
  ver: string
  process_type: string
  platform: string
  extra1: string
  extra2: string
  extra3: undefined
  _productName: string
  _companyName: string
  _version: string
}

async function waitForCrashReport() {
  for (let times = 0; times < 10; times++) {
    if (crashReporter.getLastCrashReport() != null) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('No crash report available')
}

async function checkReport(reportId: string) {
  await waitForCrashReport()
  expect(crashReporter.getLastCrashReport().id).to.equal(reportId)
  expect(crashReporter.getUploadedReports()).to.be.an('array').that.is.not.empty()
  expect(crashReporter.getUploadedReports()[0].id).to.equal(reportId)
}

function checkCrash(expectedProcessType: string, fields: CrashInfo) {
  expect(String(fields.prod)).to.equal('Electron')
  expect(String(fields.ver)).to.equal(process.versions.electron)
  expect(String(fields.process_type)).to.equal(expectedProcessType)
  expect(String(fields.platform)).to.equal(process.platform)
  expect(String(fields.extra1)).to.equal('extra1')
  expect(String(fields.extra2)).to.equal('extra2')
  expect(fields.extra3).to.be.undefined()
  expect(String(fields._productName)).to.equal('Zombies')
  expect(String(fields._companyName)).to.equal('Umbrella Corporation')
  expect(String(fields._version)).to.equal(app.getVersion())
}

let crashReporterPort = 0
const startServer = async () => {
  const crashes: CrashInfo[] = []
  function getCrashes() { return crashes }
  const emitter = new EventEmitter
  function waitForCrash(): Promise<CrashInfo> {
    return new Promise(resolve => {
      emitter.once('crash', (crash) => {
        resolve(crash)
      })
    })
  }

  const server = http.createServer((req, res) => {
    const form = new multiparty.Form()
    form.parse(req, (error, fields) => {
      crashes.push(fields)
      if (error) throw error
      const reportId = 'abc-123-def-456-abc-789-abc-123-abcd'
      res.end(reportId, async () => {
        await checkReport(reportId)
        req.socket.destroy()
        emitter.emit('crash', fields)
      })
    })
  })

  await new Promise(resolve => {
    server.listen(crashReporterPort, '127.0.0.1', () => { resolve() })
  })

  const port = (server.address() as AddressInfo).port

  if (crashReporterPort === 0) {
    // We can only start the crash reporter once, and after that these
    // parameters are fixed.
    crashReporter.start({
      companyName: 'Umbrella Corporation',
      submitURL: 'http://127.0.0.1:' + port
    })
    crashReporterPort = port
  }
<<<<<<< HEAD
||||||| parent of 35b6cdc24 (ci: cleanup up test app directories)
  const initialFiles = readdirIfPresent(dir);
  return new Promise(resolve => {
    const ivl = setInterval(() => {
      const newCrashFiles = readdirIfPresent(dir).filter(f => !initialFiles.includes(f));
      if (newCrashFiles.length) {
        clearInterval(ivl);
        resolve(newCrashFiles);
      }
    }, 1000);
  });
}

// TODO(nornagon): Fix tests on linux/arm.
ifdescribe(!isLinuxOnArm && !process.mas && !process.env.DISABLE_CRASH_REPORTER_TESTS)('crashReporter module', function () {
  afterEach(cleanup);

  describe('should send minidump', () => {
    it('when renderer crashes', async () => {
      const { port, waitForCrash } = await startServer();
      runCrashApp('renderer', port);
      const crash = await waitForCrash();
      checkCrash('renderer', crash);
      expect(crash.mainProcessSpecific).to.be.undefined();
    });

    it('when sandboxed renderer crashes', async () => {
      const { port, waitForCrash } = await startServer();
      runCrashApp('sandboxed-renderer', port);
      const crash = await waitForCrash();
      checkCrash('renderer', crash);
      expect(crash.mainProcessSpecific).to.be.undefined();
    });

    // TODO(nornagon): Minidump generation in main/node process on Linux/Arm is
    // broken (//components/crash prints "Failed to generate minidump"). Figure
    // out why.
    ifit(!isLinuxOnArm)('when main process crashes', async () => {
      const { port, waitForCrash } = await startServer();
      runCrashApp('main', port);
      const crash = await waitForCrash();
      checkCrash('browser', crash);
      expect(crash.mainProcessSpecific).to.equal('mps');
    });

    ifit(!isLinuxOnArm)('when a node process crashes', async () => {
      const { port, waitForCrash } = await startServer();
      runCrashApp('node', port);
      const crash = await waitForCrash();
      checkCrash('node', crash);
      expect(crash.mainProcessSpecific).to.be.undefined();
      expect(crash.rendererSpecific).to.be.undefined();
    });

    describe('with guid', () => {
      for (const processType of ['main', 'renderer', 'sandboxed-renderer']) {
        it(`when ${processType} crashes`, async () => {
          const { port, waitForCrash } = await startServer();
          runCrashApp(processType, port);
          const crash = await waitForCrash();
          expect(crash.guid).to.be.a('string');
        });
      }

      it('is a consistent id', async () => {
        let crash1Guid;
        let crash2Guid;
        {
          const { port, waitForCrash } = await startServer();
          runCrashApp('main', port);
          const crash = await waitForCrash();
          crash1Guid = crash.guid;
        }
        {
          const { port, waitForCrash } = await startServer();
          runCrashApp('main', port);
          const crash = await waitForCrash();
          crash2Guid = crash.guid;
        }
        expect(crash2Guid).to.equal(crash1Guid);
      });
    });

    describe('with extra parameters', () => {
      it('when renderer crashes', async () => {
        const { port, waitForCrash } = await startServer();
        runCrashApp('renderer', port, ['--set-extra-parameters-in-renderer']);
        const crash = await waitForCrash();
        checkCrash('renderer', crash);
        expect(crash.mainProcessSpecific).to.be.undefined();
        expect(crash.rendererSpecific).to.equal('rs');
        expect(crash.addedThenRemoved).to.be.undefined();
      });

      it('when sandboxed renderer crashes', async () => {
        const { port, waitForCrash } = await startServer();
        runCrashApp('sandboxed-renderer', port, ['--set-extra-parameters-in-renderer']);
        const crash = await waitForCrash();
        checkCrash('renderer', crash);
        expect(crash.mainProcessSpecific).to.be.undefined();
        expect(crash.rendererSpecific).to.equal('rs');
        expect(crash.addedThenRemoved).to.be.undefined();
      });

      it('contains v8 crash keys when a v8 crash occurs', async () => {
        const { remotely } = await startRemoteControlApp();
        const { port, waitForCrash } = await startServer();

        await remotely((port: number) => {
          require('electron').crashReporter.start({
            submitURL: `http://127.0.0.1:${port}`,
            ignoreSystemCrashHandler: true
          });
        }, [port]);

        remotely(() => {
          const { BrowserWindow } = require('electron');
          const bw = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true } });
          bw.loadURL('about:blank');
          bw.webContents.executeJavaScript('process.electronBinding(\'v8_util\').triggerFatalErrorForTesting()');
        });

        const crash = await waitForCrash();
        expect(crash.prod).to.equal('Electron');
        expect(crash._productName).to.equal('remote-control');
        expect(crash.process_type).to.equal('renderer');
        expect(crash['electron.v8-fatal.location']).to.equal('v8::Context::New()');
        expect(crash['electron.v8-fatal.message']).to.equal('Circular extension dependency');
      });
    });
  });

  ifdescribe(!isLinuxOnArm)('extra parameter limits', () => {
    function stitchLongCrashParam (crash: any, paramKey: string) {
      if (crash[paramKey]) return crash[paramKey];
      let chunk = 1;
      let stitched = '';
      while (crash[`${paramKey}__${chunk}`]) {
        stitched += crash[`${paramKey}__${chunk}`];
        chunk++;
      }
      return stitched;
    }
=======
  const initialFiles = readdirIfPresent(dir);
  return new Promise(resolve => {
    const ivl = setInterval(() => {
      const newCrashFiles = readdirIfPresent(dir).filter(f => !initialFiles.includes(f));
      if (newCrashFiles.length) {
        clearInterval(ivl);
        resolve(newCrashFiles);
      }
    }, 1000);
  });
}

// TODO(nornagon): Fix tests on linux/arm.
ifdescribe(!isLinuxOnArm && !process.mas && !process.env.DISABLE_CRASH_REPORTER_TESTS)('crashReporter module', function () {
  afterEach(cleanup);

  describe('should send minidump', () => {
    it('when renderer crashes', async () => {
      const { port, waitForCrash } = await startServer();
      runCrashApp('renderer', port);
      const crash = await waitForCrash();
      checkCrash('renderer', crash);
      expect(crash.mainProcessSpecific).to.be.undefined();
    });

    it('when sandboxed renderer crashes', async () => {
      const { port, waitForCrash } = await startServer();
      runCrashApp('sandboxed-renderer', port);
      const crash = await waitForCrash();
      checkCrash('renderer', crash);
      expect(crash.mainProcessSpecific).to.be.undefined();
    });

    // TODO(nornagon): Minidump generation in main/node process on Linux/Arm is
    // broken (//components/crash prints "Failed to generate minidump"). Figure
    // out why.
    ifit(!isLinuxOnArm)('when main process crashes', async () => {
      const { port, waitForCrash } = await startServer();
      runCrashApp('main', port);
      const crash = await waitForCrash();
      checkCrash('browser', crash);
      expect(crash.mainProcessSpecific).to.equal('mps');
    });

    ifit(!isLinuxOnArm)('when a node process crashes', async () => {
      const { port, waitForCrash } = await startServer();
      runCrashApp('node', port);
      const crash = await waitForCrash();
      checkCrash('node', crash);
      expect(crash.mainProcessSpecific).to.be.undefined();
      expect(crash.rendererSpecific).to.be.undefined();
    });

    describe('with guid', () => {
      for (const processType of ['main', 'renderer', 'sandboxed-renderer']) {
        it(`when ${processType} crashes`, async () => {
          const { port, waitForCrash } = await startServer();
          runCrashApp(processType, port);
          const crash = await waitForCrash();
          expect(crash.guid).to.be.a('string');
        });
      }

      it('is a consistent id', async () => {
        let crash1Guid;
        let crash2Guid;
        {
          const { port, waitForCrash } = await startServer();
          runCrashApp('main', port);
          const crash = await waitForCrash();
          crash1Guid = crash.guid;
        }
        {
          const { port, waitForCrash } = await startServer();
          runCrashApp('main', port);
          const crash = await waitForCrash();
          crash2Guid = crash.guid;
        }
        expect(crash2Guid).to.equal(crash1Guid);
      });
    });

    describe('with extra parameters', () => {
      it('when renderer crashes', async () => {
        const { port, waitForCrash } = await startServer();
        runCrashApp('renderer', port, ['--set-extra-parameters-in-renderer']);
        const crash = await waitForCrash();
        checkCrash('renderer', crash);
        expect(crash.mainProcessSpecific).to.be.undefined();
        expect(crash.rendererSpecific).to.equal('rs');
        expect(crash.addedThenRemoved).to.be.undefined();
      });

      it('when sandboxed renderer crashes', async () => {
        const { port, waitForCrash } = await startServer();
        runCrashApp('sandboxed-renderer', port, ['--set-extra-parameters-in-renderer']);
        const crash = await waitForCrash();
        checkCrash('renderer', crash);
        expect(crash.mainProcessSpecific).to.be.undefined();
        expect(crash.rendererSpecific).to.equal('rs');
        expect(crash.addedThenRemoved).to.be.undefined();
      });

      it('contains v8 crash keys when a v8 crash occurs', async () => {
        const { remotely } = await startRemoteControlApp();
        const { port, waitForCrash } = await startServer();

        await remotely((port: number) => {
          require('electron').crashReporter.start({
            submitURL: `http://127.0.0.1:${port}`,
            ignoreSystemCrashHandler: true
          });
        }, [port]);

        remotely(() => {
          const { BrowserWindow } = require('electron');
          const bw = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true } });
          bw.loadURL('about:blank');
          bw.webContents.executeJavaScript('process.electronBinding(\'v8_util\').triggerFatalErrorForTesting()');
        });

        const crash = await waitForCrash();
        expect(crash.prod).to.equal('Electron');
        expect(crash._productName).to.equal('electron-test-remote-control');
        expect(crash.process_type).to.equal('renderer');
        expect(crash['electron.v8-fatal.location']).to.equal('v8::Context::New()');
        expect(crash['electron.v8-fatal.message']).to.equal('Circular extension dependency');
      });
    });
  });

  ifdescribe(!isLinuxOnArm)('extra parameter limits', () => {
    function stitchLongCrashParam (crash: any, paramKey: string) {
      if (crash[paramKey]) return crash[paramKey];
      let chunk = 1;
      let stitched = '';
      while (crash[`${paramKey}__${chunk}`]) {
        stitched += crash[`${paramKey}__${chunk}`];
        chunk++;
      }
      return stitched;
    }
>>>>>>> 35b6cdc24 (ci: cleanup up test app directories)

  afterTest.push(() => { server.close() })

  return { getCrashes, port, waitForCrash }
}
