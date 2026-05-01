import {
  ConfigurableSellerSource,
  FalabellaSellerSource,
  SunatPortalEmitter,
  isFalabellaDocumentsUrl,
} from "./browser";
import { AppConfig, loadConfig, reloadRuntimeDotenv } from "./config";
import { AutomationCoordinator } from "./coordinator";
import { loadSiteProfile } from "./profiles";
import { createServer } from "./server";
import { RunStore } from "./store";

export function createAppContext(config: AppConfig) {
  const store = new RunStore(config.dataPaths.dbPath);
  store.ensureDefaultAccountFromEnv({
    label: "Principal",
    sellerUsername: config.sellerCredentials.username,
    sellerPassword: config.sellerCredentials.password,
    sunatRuc: config.sunatCredentials.ruc,
    sunatUsername: config.sunatCredentials.username,
    sunatPassword: config.sunatCredentials.password,
  });
  const resolveRunConfig = (accountId?: string) => {
    reloadRuntimeDotenv();
    const runtimeConfig = loadConfig({
      APP_PORT: String(config.port),
      APP_BASE_URL: config.appBaseUrl,
      DATA_DIR: config.dataPaths.rootDir,
    });
    if (!accountId) {
      return runtimeConfig;
    }
    const credentials = store.getAccountCredentials(accountId);
    if (!credentials) {
      return runtimeConfig;
    }
    return {
      ...runtimeConfig,
      sellerCredentials: credentials.sellerCredentials,
      sunatCredentials: credentials.sunatCredentials,
    };
  };
  const coordinator = new AutomationCoordinator(
    config,
    store,
    (runConfig, accountId) => {
      const profile = loadSiteProfile(runConfig);
      return isFalabellaDocumentsUrl(runConfig.sellerPurchasedOrdersUrl)
        ? new FalabellaSellerSource(runConfig, accountId)
        : new ConfigurableSellerSource(runConfig, profile, accountId);
    },
    (runConfig, accountId) => new SunatPortalEmitter(runConfig, loadSiteProfile(runConfig), accountId),
    resolveRunConfig,
  );
  const app = createServer(coordinator);

  return {
    app,
    coordinator,
    close: async () => {
      await coordinator.stop();
      store.close();
    },
  };
}
