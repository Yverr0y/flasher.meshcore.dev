import "/lib/beer.min.js";
import { createApp, reactive, ref, nextTick, watch, computed } from "/lib/vue.min.js";
import { Dfu } from "/lib/dfu.js";
import { ESPLoader, Transport, HardReset } from "/lib/esp32.js";
import { SerialConsole } from '/lib/console.js';
import ReadMore from '/lib/overflow.vue.js';

const logoFile = location.host === 'zephcore.meshcore.dev' ? 'zephcore.svg' : 'meshcore.svg';
const searchParams = new URLSearchParams(location.search);
const configParam = searchParams.get('config') ?? (location.host === 'zephcore.meshcore.dev' && 'config-zephcore' || '');
const configName = configParam?.replaceAll(/[^a-z_-]/g, '');
const configRes = await fetch(`/${configName || 'config'}.json`);
const config = await configRes.json();

const repos = {};

const commandReference  = {
  'time ': 'Set time {epoch-secs}',
  'erase': 'Erase filesystem',
  'advert': 'Send Advertisment packet',
  'reboot': 'Reboot device',
  'clock': 'Display current time',
  'password ': 'Set new password',
  'log': 'Ouput log',
  'log start': 'Start packet logging to file system',
  'log stop': 'Stop packet logging to file system',
  'log erase': 'Erase the packet logs from file system',
  'ver': 'Show device version',
  'set freq ': 'Set frequency {Mhz}',
  'set af ': 'Set Air-time factor',
  'set tx ': 'Set Tx power {dBm}',
  'set repeat ': 'Set repeater mode {on|off}',
  'set advert.interval ': 'Set advert rebroadcast interval {minutes}',
  'set guest.password ': 'Set guest password',
  'set name ': 'Set advertisement name',
  'set lat': 'Set the advertisement map latitude',
  'set lon': 'Set the advertisement map longitude',
  'get freq ': 'Get frequency (Mhz)',
  'get af': 'Get Air-time factor',
  'get tx': 'Get Tx power (dBm)',
  'get repeat': 'Get repeater mode',
  'get advert.interval': 'Get advert rebroadcast interval (minutes)',
  'get name': 'Get advertisement name',
  'get lat': 'Get the advertisement map latitude',
  'get lon': 'Get the advertisement map longitude',
};

async function delay(milis) {
  return await new Promise((resolve) => setTimeout(resolve, milis));
}

function toSlug(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '');
}

function getGithubReleases(github) {
  const versions = {};

  for(const [fileType, matchRE] of Object.entries(github.def.files)) {
    for(const versionType of github.repo) {
      if(versionType.type !== github.def.type) { continue }
      const version = versions[versionType.version] ??= {
        notes: versionType.notes,
        files: []
      };
      for(const file of versionType.files) {

        if(!new RegExp(matchRE).test(file.name)) { continue }
        version.files.push({
          type: fileType,
          name: `${file.url}?repo=${github.key}`,
          title: file.name,
        })
      }
    }
  }

  return versions;
}

async function getGithub(firmware) {
  const key = Object.keys(firmware).filter(name => name.startsWith('github'))

  if(!repos[key]) {
    repos[key] = await (await fetch(`/releases?repo=${key}`)).json()
  }

  return {
    key,
    repo: repos[key],
    def: firmware[key]
  }
}

async function addGithubFiles() {
  for(const device of config.device) {
    for(const firmware of device.firmware) {
      const github = await getGithub(firmware);
      if(!github?.def?.files) { continue }
      firmware.version = getGithubReleases(github);

      // clean versions without files
      for(const [verName, verValue] of Object.entries(firmware.version)) {
        if(verValue.files.length === 0) delete firmware.version[verName]
      }
    }
  }

  config.device = config.device.filter(device => device.firmware.some(firmware => Object.keys(firmware.version).length > 0 ));
  for(const device of config.device) {
    if(!Array.isArray(device.firmware)) console.error(device)
  }

  return config;
}

async function blobToBinaryString(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binString = '';

  for (let i = 0; i < bytes.length; i++) {
    binString += String.fromCharCode(bytes[i]);
  }

  return binString;
}

function setup() {
  const consoleEditBox = ref();
  const consoleWindow = ref();

  const deviceFilterText = ref('');

  const isIframe = new URLSearchParams(location.search).get('iframe');
  let displayWelcomeBanner = ref(isIframe && !localStorage.getItem('welcomeBannerDismissed'));

  const snackbar = reactive({
    text: '',
    class: '',
    icon: '',
  });

  const selected = reactive({
    device: null,
    firmware: null,
    version: null,
    firmwareClass: null,
    wipe: false,
    espFlashAddress: 0x10000,
    nrfEraserFlashingPercent: 0,
    nrfEraserFlashing: false,
    port: null,
  });

  const dismissWelcomeBanner = () => {
    localStorage.setItem('welcomeBannerDismissed', '1');
    displayWelcomeBanner.value = false;
  }

  const getRoleFwValue = (firmware, key) => {
    const role = config.role[firmware.role] ?? {};

    return firmware[key] ?? role[key] ?? '';
  }

  const getSelFwValue = (key) => {
    const fwVersion = selected.firmware.version[selected.version];

    return fwVersion ? fwVersion[key] || '' : '';
  }

  const getNotice = (selected) => {
    let notice = config.notice[selected.firmware.notice] || selected.firmware.notice || '';

    if(notice) {
      notice = notice.replaceAll(/\$\{(\w+)\}/g, (_, varName) => (Array.isArray(selected.device[varName]) ? selected.device[varName][0] : selected.device[varName]) || '');
    }

    return notice;
  }

  const checkChangeLogOverflow = () => {
    const el = content.value
    if (!el) return
    // Compare full content height against the collapsed (clamped) height.
    // Temporarily ignore overflow check while expanded.
    if (expanded.value) {
      isOverflowing.value = true
      return
    }
    isOverflowing.value = el.scrollHeight > el.clientHeight
  }

  const formatChangeLog = (changelog) => {
    return changelog
      .replace(/^Release notes:'/, '')
      .replace(/change log:\r?\n/i, '')
      .replaceAll(/^[-*] /mg, '')
      .replaceAll(/(?<!["'])(https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*))/gi, `<a target="_blank" href="$1">$1</a>`)
      .replaceAll(/#(\d+)/gm, `<a target="_blank" href="https://github.com/meshcore-dev/MeshCore/pull/$1">#$1</a>`)
//      .split(/\r?\n/)
//      .map(l => `* ${l}`)
//      .join('\n')
  }

  const flashing = reactive({
    supported: 'Serial' in window || 'serial' in window.navigator,
    instance: null,
    locked: false,
    percent: 0,
    log: '',
    error: '',
    dfuComplete: false,
  });

  const serialCon = reactive({
    instance: null,
    opened: false,
    content: '',
    edit: '',
  });

  window.app = { selected, flashing, serialCon };

  const log = {
    clean() { flashing.log = '' },
    write(data) { flashing.log += data },
    writeLine(data) { flashing.log += data + '\n' }
  };

  const retry = async() => {
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    flashing.dfuComplete = false;
    flashing.percent = 0;
    if(flashing.instance instanceof ESPLoader) {
      await flashing.instance?.hr.reset();
      await flashing.instance?.transport?.disconnect();
    }
  }

  const close = () => {
    location.reload()
  }

  const getFirmwarePath = (file) => {
    return file.name.startsWith('/') ? file.name : `${config.staticPath}/${file.name}`;
  }

  const firmwareHasData = (firmware) => {
    const firstVersion = Object.keys(firmware.version)[0];
    if(!firstVersion) return false;

    return firmware.version[firstVersion].files.length > 0;
  }

  // --- URL Routing ---
  // NOTE: the server must serve index.html for all paths (catch-all / try_files).

  const deviceToSlug = (device) => {
    const base = toSlug(device.name);
    return selected.firmwareClass ? `${selected.firmwareClass}-${base}` : base;
  };

  const firmwareToSlug = (firmware) => {
    const title = getRoleFwValue(firmware, 'title');
    const subTitle = getRoleFwValue(firmware, 'subTitle');
    return toSlug(subTitle ? `${title}-${subTitle}` : title);
  };

  let initializingFromUrl = false;

  const buildUrl = () => {
    if (serialCon.opened) return '/console';
    if (!selected.device) return '/';
    let path = '/' + deviceToSlug(selected.device) + '/';
    if (!selected.firmware) return path;
    path += firmwareToSlug(selected.firmware) + '/';
    if (selected.version) path += toSlug(selected.version);
    return path;
  };

  const updateUrl = (replace = false) => {
    if (initializingFromUrl) return;
    const path = buildUrl();
    if (window.location.pathname !== path) {
      replace ? history.replaceState(null, '', path) : history.pushState(null, '', path);
    }
  };

  const applyUrlPath = (path) => {
    initializingFromUrl = true;
    const segments = path.replace(/^\/|\/$/g, '').split('/').filter(Boolean);

    if (segments.length === 0 || segments[0] === 'console') {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }

    const [deviceSlug, roleSlug, versionSlug] = segments;

    // Detect optional firmware class prefix (e.g. "ripple-lilygo-t-deck")
    const knownClasses = ['ripple', 'meshos', 'community'];
    let firmwareClassFilter = null;
    let bareDeviceSlug = deviceSlug;
    for (const cls of knownClasses) {
      if (deviceSlug.startsWith(cls + '-')) {
        firmwareClassFilter = cls;
        bareDeviceSlug = deviceSlug.slice(cls.length + 1);
        break;
      }
    }
    selected.firmwareClass = firmwareClassFilter;

    const matchingDevices = config.device.filter(d => toSlug(d.name) === bareDeviceSlug);
    if (matchingDevices.length === 0) {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }

    // When multiple devices share the same slug, use the firmware slug to pick the right one
    let device, firmware;
    if (roleSlug && matchingDevices.length > 1) {
      for (const d of matchingDevices) {
        const f = d.firmware.find(f => firmwareToSlug(f) === roleSlug && firmwareHasData(f));
        if (f) { device = d; firmware = f; break; }
      }
    }
    if (!device) device = matchingDevices[0];
    selected.device = device;

    if (!roleSlug) {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }

    if (!firmware) firmware = device.firmware.find(f => firmwareToSlug(f) === roleSlug && firmwareHasData(f));
    if (!firmware) {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }
    selected.firmware = firmware;

    // Use nextTick so the firmware watcher sets the default version first,
    // then we override it with the version from the URL.
    nextTick(() => {
      if (versionSlug) {
        const versionName = Object.keys(firmware.version).find(v => toSlug(v) === versionSlug);
        if (versionName) selected.version = versionName;
      }
      initializingFromUrl = false;
    });
  };

  const stepBack = () => {
    if(selected.device && selected.firmware) {
      if(selected.firmware.version[selected.version].customFile) {
        selected.firmware = null;
        selected.device = null;
        return
      }

      selected.firmware = null;
      return;
    }

    if(selected.device) {
      selected.device = null;
      selected.firmwareClass = null;
    }
  }

  const flasherCleanup = async () => {
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    flashing.dfuComplete = false;
    flashing.percent = 0;
    selected.firmware = null;
    selected.version = null;
    selected.wipe = false;
    selected.device = null;
    selected.firmwareClass = null;
    selected.nrfEraserFlashingPercent = 0;
    selected.nrfEraserFlashing = false;
    if(flashing.instance instanceof ESPLoader) {
      await flashing.instance?.hr.reset();
      await flashing.instance?.transport?.disconnect();
    }
    else if(flashing.instance instanceof Dfu) {
      try {
        flashing.instance.port.close()
      }
      catch(e) {
        console.error(e);
      }
    }
    flashing.instance = null;
  }

  const openSerialGUI = () => {
    window.open('https://config.meshcore.io','meshcore_config','directories=no,titlebar=no,toolbar=no,location=no,status=no,menubar=no,scrollbars=no,resizable=no,width=1000,height=800');
  }

  const openSerialCon = async() => {
    const port = selected.port = await navigator.serial.requestPort();
    const serialConsole = serialCon.instance = new SerialConsole(port);

    serialCon.content =  '-------------------------------------------------------------------------\n';
    serialCon.content += 'Welcome to MeshCore serial console.\n'
    serialCon.content += 'Click on the cursor to get all supported commands.\n';
    serialCon.content += '-------------------------------------------------------------------------\n\n';

    serialConsole.onOutput = (text) => {
      serialCon.content += text;
    };
    serialConsole.connect();
    serialCon.opened = true;
    await nextTick();

    consoleEditBox.value.focus();
  }

  const closeSerialCon = async() => {
    serialCon.opened = false;
    await serialCon.instance.disconnect();
  }

  const sendCommand = async(text) => {
    const consoleEl = consoleWindow.value;
    serialCon.edit = '';
    await serialCon.instance.sendCommand(text);
    setTimeout(() => consoleEl.scrollTop = consoleEl.scrollHeight, 100);
  }

  const dfuMode = async() => {
    await Dfu.forceDfuMode(await navigator.serial.requestPort({}))
    flashing.dfuComplete = true;
  }

  const customFirmwareLoad = async(ev) => {
    const firmwareFile = ev.target.files[0];
    const type = firmwareFile.name.endsWith('.bin') ? 'esp32' : 'nrf52';
      selected.device = {
      name: 'Custom device',
      type,
    };
    if(firmwareFile.name.endsWith('-merged.bin')) {
      alert(
        'You selected custom file that ends with "merged.bin".'+
        'This will erase your flash! Proceed with caution.'+
        'If you want just to update your firmware, please use non-merged bin.'
      );

      selected.wipe = true;
      selected.espFlashAddress = 0;
      selected.espFlashAddress = 0;
    }

    selected.firmware = {
      icon: 'unknown_document',
      title: firmwareFile.name,
      version: {},
    }
    selected.version = firmwareFile.name;
    selected.firmware.version[selected.version] = {
      customFile: true,
      files: [{ type: 'flash', file: firmwareFile }]
    }
  }

  const espReset = async(t) => {
    await t.setRTS(true);
    await delay(100)
    await t.setRTS(false);
  }

  const nrfErase = async() => {
    if(!(selected.device.type === 'nrf52' && selected.device.erase)) {
      console.error('nRF erase called for non-nrf device or device.erase is not defined')
      return;
    }

    const url = `${config.staticPath}/${selected.device.erase}`;

    console.log('downloading: ' + url);
    const resp = await fetch(url);
    if(resp.status !== 200) {
      alert(`Could not download the firmware file from the server, reported: HTTP ${resp.status}.\nPlease try again.`)
      return;
    }
    const flashData = await resp.blob();

    const port = selected.port = await navigator.serial.requestPort({});
    const dfu = new Dfu(port);

    try {
      selected.nrfEraserFlashing = true;
      await dfu.dfuUpdate(flashData, async (progress) => {
        selected.nrfEraserFlashingPercent = progress;
        if(progress === 100 && selected.nrfEraserFlashing) {
          selected.nrfEraserFlashing = false;
          selected.dfuComplete = false;
          setTimeout(() => {
            alert('Device erase firmware has been flashed and flash has been erased.\nYou can flash MeshCore now.');
          }, 200);
        }
      }, 60000);

    }
    catch(e) {
      alert(`nRF flashing erase firmware failed: ${e}.\nDid you put the device into DFU mode before attempting erasing?`);
      selected.nrfEraserFlashing = false;
      selected.nrfEraserFlashingPercent = 0;
      return;
    }
  }

  const canFlash = (device) => {
    return device.type !== 'noflash'
  }

  const flashDevice = async() => {
    const device = selected.device;
    const firmware = selected.firmware.version[selected.version];

    const flashFiles = firmware.files.filter(f => f.type.startsWith('flash'));
    if(!flashFiles[0]) {
      alert('Cannot find configuration for flash file! please report this to Discord.')
      flasherCleanup();
      return;
    }

    let flashData;
    if(flashFiles[0].file) {
      flashData = flashFiles[0].file;
    } else {
      let flashFile;
      if(device.type === 'esp32') {
        flashFile = flashFiles.find(f => f.type === (selected.wipe ? 'flash-wipe' : 'flash-update'));
        if(selected.wipe) selected.espFlashAddress = 0x00000;
        if(selected.wipe) selected.espFlashAddress = 0x00000;
      }
      else {
        flashFile = flashFiles[0];
      }
      console.log({flashFiles, flashFile});

      const url = getFirmwarePath(flashFile);
      console.log('downloading: ' + url);
      const resp = await fetch(url);
      if(resp.status !== 200) {
        alert(`Could not download the firmware file from the server, reported: HTTP ${resp.status}.\nPlease try again.`)
        return;
      }

      flashData = await resp.blob();
    }

    const port = selected.port = await navigator.serial.requestPort({});

    if(device.type === 'esp32') {
      let esploader;
      let transport;

      const flashOptions = {
        terminal: log,
        compress: true,
        eraseAll: selected.wipe,
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        baudrate: 115200,
        romBaudrate: 115200,
        enableTracing: false,
        fileArray: [{
          data: await blobToBinaryString(flashData),
          address: selected.espFlashAddress
        }],
        reportProgress: async (_, written, total) => {
          flashing.percent = (written / total) * 100;
        },
      };

      try {
        flashing.active = true;
        transport = new Transport(port, true);
        flashOptions.transport = transport;
        flashing.instance = esploader = new ESPLoader(flashOptions);
        esploader.hr = new HardReset(transport);
        await esploader.main();
        await esploader.flashId();
      }
      catch(e) {
        console.error(e);
        flashing.error = `Failed to initialize. Did you place the device into firmware download mode? Detail: ${e}`;
        esploader = null;
        return;
      }

      try {
        await esploader.writeFlash(flashOptions);
        await delay(100);
        await esploader.after('hard_reset');
        await delay(100);
        await espReset(transport);
        await transport.disconnect();
      }
      catch(e) {
        console.error(e);
        flashing.error = `ESP32 flashing failed: ${e}`;
        await espReset(transport);
        await transport.disconnect();
        return;
      }
    }
    else if(device.type === 'nrf52') {
      const dfu = flashing.instance = new Dfu(port);

      flashing.active = true;

      try {
        await dfu.dfuUpdate(flashData, async (progress) => {
          flashing.percent = progress;
        }, 60000);

      }
      catch(e) {
        console.error(e);
        flashing.error = `nRF flashing failed: ${e}. Please reset the device and try again.`;
        return;
      }
    }
  };

  const devices = computed(() => {
    return config.device
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .filter(d => deviceFilterText.value === '' || d.name.toLowerCase().includes(deviceFilterText.value?.toLowerCase()));
  });

  const deviceFirmwareByClass = computed(() => {
    if (!selected.device) return {};
    const classOrder = ['ripple', 'meshos', 'community'];
    const groups = {};
    for (const fw of selected.device.firmware) {
      if (!firmwareHasData(fw)) continue;
      if (selected.firmwareClass && fw.class !== selected.firmwareClass) continue;
      const cls = fw.class || 'other';
      if (!groups[cls]) groups[cls] = [];
      groups[cls].push(fw);
    }
    const ordered = {};
    for (const cls of [...classOrder, ...Object.keys(groups).filter(c => !classOrder.includes(c))]) {
      if (groups[cls]) ordered[cls] = groups[cls];
    }
    return ordered;
  });

  const showMessage = (text, icon, displayMs) => {
    snackbar.class = 'active';
    snackbar.text = text;
    snackbar.icon = icon || '';

    setTimeout(() => {
      snackbar.icon = '';
      snackbar.text = '';
      snackbar.class = '';
    }, displayMs || 2000);
  }

  const consoleMouseUp = (ev) => {
    if(window.getSelection().toString().length) {
      navigator.clipboard.writeText(window.getSelection().toString())
      showMessage('text copied to clipboard');
    }
    consoleEditBox.value.focus();
  }

  watch(() => selected.firmware, (firmware) => {
    if(firmware == null) return;
    selected.version = Object.keys(firmware.version)[0];
  });

  watch(() => selected.device, updateUrl);
  watch(() => selected.firmware, updateUrl);
  watch(() => selected.version, () => updateUrl(true));  // replace: version is a refinement, not a new nav step
  watch(() => serialCon.opened, updateUrl);

  window.addEventListener('popstate', () => {
    if (serialCon.opened) closeSerialCon();
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    selected.firmware = null;
    selected.version = null;
    selected.device = null;
    applyUrlPath(window.location.pathname);
  });

  applyUrlPath(window.location.pathname);

  return {
    isIframe, displayWelcomeBanner, dismissWelcomeBanner,
    snackbar,
    consoleEditBox, consoleWindow, consoleMouseUp,
    config, devices, deviceFirmwareByClass, selected, flashing, deviceFilterText,
    flashDevice, flasherCleanup, dfuMode,
    serialCon, closeSerialCon, openSerialCon,
    sendCommand, openSerialGUI,
    retry, close, commandReference,
    stepBack,
    customFirmwareLoad, getFirmwarePath,
    getSelFwValue, getRoleFwValue, getNotice, formatChangeLog,
    customFirmwareLoad, getFirmwarePath,
    getSelFwValue, getRoleFwValue, getNotice, formatChangeLog,
    firmwareHasData,
    canFlash, nrfErase, logoFile
  }
}

console.log(await addGithubFiles());

createApp({
  setup,
  components: { ReadMore },
}).mount('#app');
