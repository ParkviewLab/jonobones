// The anti-corruption layer's entry point. This directory is the ONLY place
// allowed to import @joplin/lib (enforced by eslint no-restricted-imports).
//
// @joplin/lib is compiled CommonJS with no main entry and no API stability
// guarantee, so we deep-require the compiled .js files via createRequire and
// keep the handles on a context object. The bootstrap sequence mirrors the
// lib's own minimal headless boot (testing/test-utils.ts + jest.setup.js),
// the same sequence proven by the M0 spike (spike/lib-spike.mjs).
//
// Hard-won facts encoded here:
// - shimInit must receive nodeSqlite (the `sqlite3` module); the DB driver
//   resolves it via shim.nodeSqlite().
// - shim.appVersion() feeds the sync-target compatibility handshake
//   (checkIfCanSync), so it reports the embedded @joplin/lib version, NOT
//   the jonobones product version.
// - FsDriverNode must be injected as statics on Logger/Resource/
//   EncryptionService/FileApiDriverLocal before anything touches files.
// - @joplin/lib state is process-global (Setting constants, BaseModel db,
//   service singletons): exactly one Joplin context per process.

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const req = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any -- the lib boundary is
   intentionally untyped; src/joplin wraps it in honest signatures. */
export interface LibHandles {
  Setting: any;
  BaseModel: any;
  BaseItem: any;
  Note: any;
  Folder: any;
  Resource: any;
  Tag: any;
  NoteTag: any;
  MasterKey: any;
  Revision: any;
  ItemChange: any;
  ModelType: any;
  restoreItems: (itemType: any, ids: string[], options?: any) => Promise<void>;
  shim: any;
  SearchEngine: any;
  setItemUserData: (itemType: any, itemId: string, ns: string, key: string, value: unknown, deleted?: boolean) => Promise<unknown>;
  getItemUserData: (itemType: any, itemId: string, ns: string, key: string) => Promise<unknown>;
  deleteItemUserData: (itemType: any, itemId: string, ns: string, key: string) => Promise<unknown>;
  database: any;
  registry: any;
  SyncTargetRegistry: any;
  ResourceFetcher: any;
  BaseItemClass: any;
  syncInfoUtils: { localSyncInfo: () => any; getEncryptionEnabled: () => boolean };
  e2eeUtils: {
    loadMasterKeysFromSettings: (service: any) => Promise<void>;
    masterPasswordIsValid: (password: string, activeMasterKey?: any) => Promise<boolean>;
    getDefaultMasterKey: () => any;
    generateMasterKeyAndEnableEncryption: (service: any, password: string) => Promise<any>;
  };
  libVersion: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- lib boundary */
export interface JoplinServices {
  encryptionService: any;
  revisionService: any;
  decryptionWorker: any;
  resourceFetcher: any | null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ItemEventSink {
  /** Resolves once the event is durably in the journal — API handlers await
   *  this, so an HTTP response guarantees the event exists. */
  emit(
    itemType: 'note' | 'notebook' | 'tag' | 'resource',
    itemId: string,
    changeType: 'create' | 'update' | 'delete',
  ): Promise<void>;
}

export interface JoplinContext {
  lib: LibHandles;
  services: JoplinServices;
  /** Set by the daemon once the event journal is open; mutations emit here. */
  events?: ItemEventSink;
  /** The stock Joplin client profile dir: <jonobones profile>/joplin */
  joplinProfileDir: string;
  shutdown(): Promise<void>;
}

let started = false;

export interface BootstrapOptions {
  /** The jonobones profile dir; the Joplin profile lives in its joplin/ subdir. */
  profileDir: string;
}

export async function bootstrapJoplin({ profileDir }: BootstrapOptions): Promise<JoplinContext> {
  if (started) throw new Error('@joplin/lib is process-global: only one Joplin context per process');
  started = true;

  const joplinProfileDir = join(profileDir, 'joplin');
  const resourceDir = join(joplinProfileDir, 'resources');
  const tempDir = join(joplinProfileDir, 'tmp');
  const cacheDir = join(joplinProfileDir, 'cache');
  for (const dir of [joplinProfileDir, resourceDir, tempDir, cacheDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const { shimInit } = req('@joplin/lib/shim-init-node.js');
  const sqlite3 = req('sqlite3');
  const libVersion: string = req('@joplin/lib/package.json').version;
  shimInit({ nodeSqlite: sqlite3, appVersion: () => libVersion });

  const LoggerModule = req('@joplin/utils/Logger');
  const Logger = LoggerModule.default;
  const { TargetType } = LoggerModule;
  const initLib = req('@joplin/lib/initLib.js').default;
  const FsDriverNode = req('@joplin/lib/fs-driver-node.js').default;
  const SettingModule = req('@joplin/lib/models/Setting.js');
  const Setting = SettingModule.default;
  const { AppType, Env } = SettingModule;
  const BaseModel = req('@joplin/lib/BaseModel.js').default;
  const { ModelType } = req('@joplin/lib/BaseModel.js');
  const BaseItem = req('@joplin/lib/models/BaseItem.js').default;
  const Note = req('@joplin/lib/models/Note.js').default;
  const Folder = req('@joplin/lib/models/Folder.js').default;
  const Resource = req('@joplin/lib/models/Resource.js').default;
  const Tag = req('@joplin/lib/models/Tag.js').default;
  const NoteTag = req('@joplin/lib/models/NoteTag.js').default;
  const MasterKey = req('@joplin/lib/models/MasterKey.js').default;
  const Revision = req('@joplin/lib/models/Revision.js').default;
  const ItemChange = req('@joplin/lib/models/ItemChange.js').default;
  const restoreItems = req('@joplin/lib/services/trash/restoreItems.js').default;
  const shim = req('@joplin/lib/shim.js').default;
  const SearchEngine = req('@joplin/lib/services/search/SearchEngine.js').default;
  const { setItemUserData, getItemUserData, deleteItemUserData } = req('@joplin/lib/models/utils/userData.js');
  const ResourceFetcher = req('@joplin/lib/services/ResourceFetcher.js').default;
  const { localSyncInfo, getEncryptionEnabled } = req('@joplin/lib/services/synchronizer/syncInfoUtils.js');
  const {
    loadMasterKeysFromSettings,
    masterPasswordIsValid,
    getDefaultMasterKey,
    generateMasterKeyAndEnableEncryption,
  } = req('@joplin/lib/services/e2ee/utils.js');
  const JoplinDatabase = req('@joplin/lib/JoplinDatabase.js').default;
  const { DatabaseDriverNode } = req('@joplin/lib/database-driver-node.js');
  const SyncTargetRegistry = req('@joplin/lib/SyncTargetRegistry.js').default;
  const SyncTargetFilesystem = req('@joplin/lib/SyncTargetFilesystem.js').default;
  const SyncTargetJoplinServer = req('@joplin/lib/SyncTargetJoplinServer.js').default;
  const SyncTargetJoplinCloud = req('@joplin/lib/SyncTargetJoplinCloud.js').default;
  const SyncTargetOneDrive = req('@joplin/lib/SyncTargetOneDrive.js').default;
  const SyncTargetNextcloud = req('@joplin/lib/SyncTargetNextcloud.js');
  const SyncTargetWebDAV = req('@joplin/lib/SyncTargetWebDAV.js');
  const SyncTargetDropbox = req('@joplin/lib/SyncTargetDropbox.js');
  const SyncTargetAmazonS3 = req('@joplin/lib/SyncTargetAmazonS3.js');
  const FileApiDriverLocal = req('@joplin/lib/file-api-driver-local.js').default;
  const { reg } = req('@joplin/lib/registry.js');
  const BaseService = req('@joplin/lib/services/BaseService.js').default;
  const EncryptionService = req('@joplin/lib/services/e2ee/EncryptionService.js').default;
  const RevisionService = req('@joplin/lib/services/RevisionService.js').default;
  const DecryptionWorker = req('@joplin/lib/services/DecryptionWorker.js').default;
  const KvStore = req('@joplin/lib/services/KvStore.js').default;
  const { loadKeychainServiceAndSettings } = req('@joplin/lib/services/SettingUtils.js');
  const KeychainServiceDriverDummy = req('@joplin/lib/services/keychain/KeychainServiceDriver.dummy.js').default;
  const { setRSA } = req('@joplin/lib/services/e2ee/ppk/ppk.js');
  const RSA = req('@joplin/lib/services/e2ee/ppk/RSA.node.js').default;

  const logger = new Logger();
  logger.addTarget(TargetType.Console);
  logger.setLevel(Logger.LEVEL_WARN);
  Logger.initializeGlobalLogger(logger);
  initLib(logger);

  const fsDriver = new FsDriverNode();
  Logger.fsDriver_ = fsDriver;
  Resource.fsDriver_ = fsDriver;
  EncryptionService.fsDriver_ = fsDriver;
  FileApiDriverLocal.fsDriver_ = fsDriver;
  BaseService.logger_ = logger;

  BaseItem.loadClass('Note', Note);
  BaseItem.loadClass('Folder', Folder);
  BaseItem.loadClass('Resource', Resource);
  BaseItem.loadClass('Tag', Tag);
  BaseItem.loadClass('NoteTag', NoteTag);
  BaseItem.loadClass('MasterKey', MasterKey);
  BaseItem.loadClass('Revision', Revision);

  Setting.setConstant('appId', 'org.parkviewlab.jonobones');
  Setting.setConstant('appType', AppType.Cli);
  Setting.setConstant('env', Env.Prod);
  Setting.setConstant('profileDir', joplinProfileDir);
  Setting.setConstant('rootProfileDir', joplinProfileDir);
  Setting.setConstant('resourceDirName', 'resources');
  Setting.setConstant('resourceDir', resourceDir);
  Setting.setConstant('tempDir', tempDir);
  Setting.setConstant('cacheDir', cacheDir);
  Setting.setConstant('pluginDataDir', join(joplinProfileDir, 'plugin-data'));
  Setting.setConstant('pluginDir', join(joplinProfileDir, 'plugins'));
  Setting.setConstant('isSubProfile', false);

  SyncTargetRegistry.addClass(SyncTargetFilesystem);
  SyncTargetRegistry.addClass(SyncTargetJoplinServer);
  SyncTargetRegistry.addClass(SyncTargetJoplinCloud);
  SyncTargetRegistry.addClass(SyncTargetOneDrive);
  SyncTargetRegistry.addClass(SyncTargetNextcloud);
  SyncTargetRegistry.addClass(SyncTargetWebDAV);
  SyncTargetRegistry.addClass(SyncTargetDropbox);
  SyncTargetRegistry.addClass(SyncTargetAmazonS3);

  const dbLogger = new Logger();
  dbLogger.addTarget(TargetType.Console);
  dbLogger.setLevel(Logger.LEVEL_WARN);

  const database = new JoplinDatabase(new DatabaseDriverNode());
  database.setLogger(dbLogger);
  await database.open({ name: join(joplinProfileDir, 'database.sqlite') });
  BaseModel.setDb(database);
  reg.setDb(database);

  await loadKeychainServiceAndSettings([KeychainServiceDriverDummy]);

  const encryptionService = new EncryptionService();
  BaseItem.encryptionService_ = encryptionService;
  Resource.encryptionService_ = encryptionService;
  const revisionService = new RevisionService();
  BaseItem.revisionService_ = revisionService;
  const decryptionWorker = new DecryptionWorker();
  decryptionWorker.setEncryptionService(encryptionService);
  DecryptionWorker.instance_ = decryptionWorker;
  KvStore.instance().setDb(database);
  decryptionWorker.setKvStore(KvStore.instance());
  SearchEngine.instance().setDb(database);
  setRSA(RSA);

  const lib: LibHandles = {
    Setting,
    BaseModel,
    BaseItem,
    Note,
    Folder,
    Resource,
    Tag,
    NoteTag,
    MasterKey,
    Revision,
    ItemChange,
    ModelType,
    restoreItems,
    shim,
    SearchEngine,
    setItemUserData,
    getItemUserData,
    deleteItemUserData,
    database,
    registry: reg,
    SyncTargetRegistry,
    ResourceFetcher,
    BaseItemClass: BaseItem,
    syncInfoUtils: { localSyncInfo, getEncryptionEnabled },
    e2eeUtils: {
      loadMasterKeysFromSettings,
      masterPasswordIsValid,
      getDefaultMasterKey,
      generateMasterKeyAndEnableEncryption,
    },
    libVersion,
  };

  const services = {
    encryptionService,
    revisionService,
    decryptionWorker,
    resourceFetcher: null,
  };

  return {
    lib,
    services,
    joplinProfileDir,
    async shutdown() {
      await ItemChange.waitForAllSaved();
      Setting.cancelScheduleSave();
      await Setting.saveAll();
      await database.close();
    },
  };
}
