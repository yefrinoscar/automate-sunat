import fs from "node:fs";
import path from "node:path";
import { Browser, BrowserContext, Download, Frame, Locator, Page, chromium } from "playwright";
import { AppConfig } from "./config";
import {
  Artifact,
  InvoiceDraft,
  Sale,
  SaleItem,
  normalizeSale,
  parseAmount,
} from "./domain";
import { SiteProfile } from "./profiles";

export type StepReporter = (step: string) => void | Promise<void>;

export interface SubmissionContext {
  runId?: string;
  boletasDownloadDir?: string;
}

export interface FetchSalesOptions {
  /** Fecha local YYYY-MM-DD. Si falta, no se abre el date picker en Documentos tributarios (Falabella). */
  falabellaDocumentsSearchFromIso?: string;
  /** Fecha local YYYY-MM-DD. Si falta, se asume "hoy" cuando se usa el filtro de fechas. */
  falabellaDocumentsSearchToIso?: string;
}

export interface SellerSource {
  fetchSales(onStep: StepReporter, options?: FetchSalesOptions): Promise<Sale[]>;
  refreshSale(externalId: string, onStep: StepReporter, options?: FetchSalesOptions): Promise<Sale | undefined>;
  captureSaleEvidence(sale: Sale, attemptId: string, onStep: StepReporter): Promise<Artifact[]>;
}

export interface PreparedSubmission {
  preSubmitArtifacts: Artifact[];
  waitForInterruption(): Promise<string>;
  submit(onStep: StepReporter): Promise<{
    artifacts: Artifact[];
    receiptNumber?: string;
    receiptPrefix?: string;
  }>;
  cancel(onStep: StepReporter): Promise<Artifact[]>;
}

export interface InvoiceEmitter {
  prepareSubmission(
    attemptId: string,
    draft: InvoiceDraft,
    onStep: StepReporter,
    context?: SubmissionContext,
  ): Promise<PreparedSubmission>;
}

export class AutomationError extends Error {
  constructor(message: string, public readonly artifacts: Artifact[] = []) {
    super(message);
    this.name = "AutomationError";
  }
}

export class OperatorCancelledError extends AutomationError {
  constructor(message = "Flujo cancelado porque el operador cerró el navegador.", artifacts: Artifact[] = []) {
    super(message, artifacts);
    this.name = "OperatorCancelledError";
  }
}

export class OmitSaleError extends AutomationError {
  constructor(message: string, artifacts: Artifact[] = []) {
    super(message, artifacts);
    this.name = "OmitSaleError";
  }
}

type PageScope = Page | Frame;
type SunatValidationWatcherController = {
  pause(reason?: string): void;
  resume(): void;
  stop(): void;
  isPaused(): boolean;
};

const SUNAT_TIMING = {
  validationIframePollMs: 750,
  validationIframePostFoundPauseMs: 250,
  loginPostRucTabPauseMs: 150,
  loginPostSubmitNetworkIdleTimeoutMs: 5_000,
  menuClickPauseMs: 200,
  notificationsDismissPauseMs: 250,
  processingMarkerAppearTimeoutMs: 1_200,
  processingMarkerAppearPollMs: 150,
  processingPollMs: 250,
  processingProgressLogMs: 4_000,
  postDocumentFillProcessingTimeoutMs: 6_000,
  postCustomerContinueProcessingTimeoutMs: 8_000,
  postTransportAcceptProcessingTimeoutMs: 8_000,
  itemDialogPollMs: 150,
  itemGridPollMs: 150,
  itemAmountPreviewPollMs: 150,
  inconsistentIdentityRetryPauseMs: 300,
  inconsistentIdentitySecondRetryPauseMs: 250,
  postInconsistentIdentityRecoveryPauseMs: 250,
  postWithoutDocumentSelectionPauseMs: 200,
  currencyTypingDelayMs: 25,
} as const;

const SUNAT_REQUIRES_HEADFUL = true;

export function isFalabellaDocumentsUrl(url: string): boolean {
  return /sellercenter\.falabella\.com\/order\/invoice/i.test(url);
}

export function falabellaDocumentsTextLooksEmpty(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return [
    "no hay datos",
    "sin resultados",
    "no encontramos resultados",
    "no se encontraron resultados",
    "no hay registros",
    "no hay documentos tributarios",
    "no existen datos",
    "ningun resultado",
    "ningún resultado",
    "no hay informacion disponible",
    "no hay información disponible",
    "no data",
    "no data found",
  ].some((pattern) => normalized.includes(pattern));
}

function accountScopedAuthFileName(accountId: string | undefined, baseFileName: string): string {
  if (!accountId) {
    return baseFileName;
  }
  const safe = accountId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const ext = path.extname(baseFileName);
  const stem = ext ? baseFileName.slice(0, -ext.length) : baseFileName;
  return `${stem}-${safe}${ext || ".json"}`;
}

export class ConfigurableSellerSource implements SellerSource {
  constructor(
    private readonly config: AppConfig,
    private readonly profile: SiteProfile,
    private readonly accountId?: string,
  ) {}

  async fetchSales(onStep: StepReporter, _options?: FetchSalesOptions): Promise<Sale[]> {
    await onStep("Abriendo sesión del navegador para Seller");

    const browser = await this.launchBrowser();
    const context = await this.newContext(browser, accountScopedAuthFileName(this.accountId, "seller.json"));
    const page = await context.newPage();

    try {
      await this.loginIfNeeded(
        page,
        this.profile.seller.login,
        this.config.sellerCredentials,
        onStep,
      );
      await onStep("Abriendo la página de ventas del seller");
      await page.goto(this.profile.seller.salesUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(this.profile.seller.saleRowSelector);

      const seenSales = new Set<string>();
      const sales: Sale[] = [];
      const visitedPageStates = new Set<string>();
      let visitedPages = 0;

      while (true) {
        await page.waitForSelector(this.profile.seller.saleRowSelector);
        const pageState = await this.buildSellerPageStateKey(page);

        if (visitedPageStates.has(pageState)) {
          break;
        }

        visitedPageStates.add(pageState);
        visitedPages += 1;
        await onStep(`Revisando la página ${visitedPages} de ventas del seller`);

        const rowCount = await page.locator(this.profile.seller.saleRowSelector).count();

        for (let index = 0; index < rowCount; index += 1) {
          const row = page.locator(this.profile.seller.saleRowSelector).nth(index);
          const detailHref = await row
            .locator(this.profile.seller.detailLinkSelector)
            .first()
            .getAttribute("href");

          if (!detailHref) {
            continue;
          }

          const externalId = await readText(row, this.profile.seller.saleIdSelector);
          if (seenSales.has(externalId)) {
            continue;
          }

          await onStep(`Leyendo la venta ${externalId} del seller`);
          const detailUrl = new URL(detailHref, this.profile.seller.salesUrl).toString();
          const detailPage = await context.newPage();

          try {
            await detailPage.goto(detailUrl, { waitUntil: "domcontentloaded" });
            await detailPage.waitForSelector(this.profile.seller.detailPage.itemRowSelector);

            const itemCount = await detailPage
              .locator(this.profile.seller.detailPage.itemRowSelector)
              .count();
            const items: SaleItem[] = [];

            for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
              const itemRow = detailPage
                .locator(this.profile.seller.detailPage.itemRowSelector)
                .nth(itemIndex);
              const quantity = parseAmount(
                await readText(itemRow, this.profile.seller.detailPage.itemQuantitySelector),
              );
              const unitPrice = parseAmount(
                await readText(itemRow, this.profile.seller.detailPage.itemUnitPriceSelector),
              );
              const itemTotalSelector = this.profile.seller.detailPage.itemTotalSelector;
              const total =
                itemTotalSelector && (await itemRow.locator(itemTotalSelector).count()) > 0
                  ? parseAmount(await readText(itemRow, itemTotalSelector))
                  : quantity * unitPrice;

              items.push({
                description: await readText(
                  itemRow,
                  this.profile.seller.detailPage.itemDescriptionSelector,
                ),
                quantity,
                unitPrice,
                total,
              });
            }

            const total = await readPreferredAmount({
              primaryScope: row,
              primarySelector: this.profile.seller.totalSelector,
              fallbackScope: detailPage,
              fallbackSelector: this.profile.seller.detailPage.totalSelector,
            });
            const subtotal = items.reduce((sum, item) => sum + item.total, 0);
            sales.push(
              normalizeSale({
                externalId,
                issuedAt: await readPreferredText({
                  primaryScope: row,
                  primarySelector: this.profile.seller.issuedAtSelector,
                  fallbackScope: detailPage,
                  fallbackSelector: this.profile.seller.detailPage.issuedAtSelector,
                }),
                currency: "PEN",
                customer: {
                  name: await readPreferredText({
                    primaryScope: row,
                    primarySelector: this.profile.seller.customerNameSelector,
                    fallbackScope: detailPage,
                    fallbackSelector: this.profile.seller.detailPage.customerNameSelector,
                  }),
                  documentNumber: await readPreferredText({
                    primaryScope: row,
                    primarySelector: this.profile.seller.customerDocumentSelector,
                    fallbackScope: detailPage,
                    fallbackSelector: this.profile.seller.detailPage.customerDocumentSelector,
                  }),
                  email: await readPreferredOptionalText({
                    primaryScope: row,
                    primarySelector: this.profile.seller.customerEmailSelector,
                    fallbackScope: detailPage,
                    fallbackSelector: this.profile.seller.detailPage.customerEmailSelector,
                  }),
                },
                items,
                totals: {
                  subtotal,
                  tax: Math.max(total - subtotal, 0),
                  total: total || subtotal,
                },
                raw: {
                  detailUrl,
                },
              }),
            );
            seenSales.add(externalId);
          } finally {
            await detailPage.close();
          }
        }

        const movedToNextPage = await this.goToNextSellerSalesPage(page, pageState);
        if (!movedToNextPage) {
          break;
        }
      }

      await onStep(`Revisión del seller completada: ${visitedPages} página(s) inspeccionada(s).`);

      await context.storageState({
        path: this.authFile(accountScopedAuthFileName(this.accountId, "seller.json")),
      });
      return sales;
    } finally {
      await context.close();
      await browser.close();
    }
  }

  async refreshSale(
    externalId: string,
    onStep: StepReporter,
    options?: FetchSalesOptions,
  ): Promise<Sale | undefined> {
    const sales = await this.fetchSales(onStep, options);
    return sales.find((sale) => sale.externalId === externalId);
  }

  async captureSaleEvidence(
    sale: Sale,
    attemptId: string,
    onStep: StepReporter,
  ): Promise<Artifact[]> {
    const detailUrl = String(sale.raw.detailUrl ?? "");

    if (!detailUrl) {
      return [];
    }

    await onStep(`Capturando evidencia del seller para ${sale.externalId}`);
    const browser = await this.launchBrowser();
    const context = await this.newContext(browser, accountScopedAuthFileName(this.accountId, "seller.json"));
    const page = await context.newPage();

    try {
      await this.loginIfNeeded(
        page,
        this.profile.seller.login,
        this.config.sellerCredentials,
        onStep,
      );
      await page.goto(detailUrl, { waitUntil: "domcontentloaded" });

      const screenshotPath = path.join(
        this.config.dataPaths.screenshotsDir,
        `${attemptId}-seller-detail.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await context.storageState({
        path: this.authFile(accountScopedAuthFileName(this.accountId, "seller.json")),
      });
      return [{ kind: "screenshot", path: screenshotPath }];
    } finally {
      await context.close();
      await browser.close();
    }
  }

  private async launchBrowser(): Promise<Browser> {
    return chromium.launch({
      headless: !this.config.headful,
      slowMo: this.config.slowMoMs,
    });
  }

  private async newContext(browser: Browser, authFileName: string): Promise<BrowserContext> {
    const authPath = this.authFile(authFileName);
    if (fs.existsSync(authPath)) {
      return browser.newContext({ storageState: authPath });
    }
    return browser.newContext();
  }

  private authFile(fileName: string): string {
    return path.join(this.config.dataPaths.authDir, fileName);
  }

  private async buildSellerPageStateKey(page: Page): Promise<string> {
    const firstRow = page.locator(this.profile.seller.saleRowSelector).first();
    const rowKey = await firstRow.getAttribute("data-row-key").catch(() => null);
    const firstRowText = ((await firstRow.textContent().catch(() => "")) ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    const rowCount = await page.locator(this.profile.seller.saleRowSelector).count().catch(() => 0);

    return `${page.url()}|${rowKey ?? (firstRowText || "no-row")}|${rowCount}`;
  }

  private async goToNextSellerSalesPage(page: Page, previousState: string): Promise<boolean> {
    const nextControl = await this.findNextSellerPageControl(page);

    if (!nextControl) {
      return false;
    }

    const previousUrl = page.url();
    await nextControl.scrollIntoViewIfNeeded().catch(() => undefined);
    await nextControl.click({ noWaitAfter: true }).catch(() => undefined);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(300);
      const currentState = await this.buildSellerPageStateKey(page);
      if (currentState !== previousState || page.url() !== previousUrl) {
        await page.waitForSelector(this.profile.seller.saleRowSelector);
        return true;
      }
    }

    return false;
  }

  private async findNextSellerPageControl(page: Page): Promise<Locator | undefined> {
    const candidates = [
      page.locator("li.ant-pagination-next button").first(),
      page.locator("li.ant-pagination-next").first(),
      page.locator(".pagination .next:not(.disabled) a, .pagination .next:not(.disabled) button").first(),
      page.locator("a[rel='next'], button[rel='next']").first(),
      page.locator("[aria-label*='next' i], [title*='next' i]").first(),
      page.getByRole("button", { name: /siguiente|next|pr[oó]xima|>/i }).first(),
      page.getByRole("link", { name: /siguiente|next|pr[oó]xima|>/i }).first(),
    ];

    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      const disabled =
        (await candidate.isDisabled().catch(() => false))
        || (await candidate.getAttribute("disabled").catch(() => null)) !== null
        || (await candidate.getAttribute("aria-disabled").catch(() => null)) === "true"
        || (await candidate
          .evaluate((element) =>
            element.classList.contains("disabled")
              || element.classList.contains("ant-pagination-disabled")
              || element.classList.contains("is-disabled"))
          .catch(() => false));

      if (!disabled) {
        return candidate;
      }
    }

    return undefined;
  }

  private async loginIfNeeded(
    page: Page,
    login: SiteProfile["seller"]["login"],
    credentials: { username: string; password: string },
    onStep: StepReporter,
  ): Promise<void> {
    await performLoginFlow({
      page,
      login,
      credentials,
      onStep,
      stepLabel: "Autenticando en el sitio del seller",
    });
  }
}

export class FalabellaSellerSource implements SellerSource {
  constructor(
    private readonly config: AppConfig,
    private readonly accountId?: string,
  ) {}

  async fetchSales(onStep: StepReporter, options?: FetchSalesOptions): Promise<Sale[]> {
    await onStep("Abriendo Falabella Seller Center");

    const browser = await launchBrowser(this.config);
    const context = await newFalabellaContext(browser, this.authFilePath());
    const page = await context.newPage();

    try {
      await loginToFalabella(page, this.config.sellerCredentials, onStep, this.config.sellerPurchasedOrdersUrl);
      await openFalabellaDocumentsPage(page, this.config.sellerPurchasedOrdersUrl, this.config, onStep);
      const searchFromIso = options?.falabellaDocumentsSearchFromIso;
      const searchToIso = options?.falabellaDocumentsSearchToIso;
      const candidates = await collectFalabellaPendingRowsAcrossPages(page, onStep, searchFromIso, searchToIso);
      const sales: Sale[] = [];

      for (const candidate of candidates) {
        await onStep(`Abriendo detalle de la orden ${candidate.externalId} en Falabella`);
        const detailPage = await context.newPage();

        try {
          const detailMap = await waitForFalabellaOrderDetailReady(
            detailPage,
            candidate.detailUrl,
            this.config,
            candidate.externalId,
            onStep,
          );

          if (falabellaDetailIndicatesFactura(detailMap)) {
            await onStep(
              `Orden ${candidate.externalId}: en detalle «Documento tributario» es Factura; no la agrego y sigo con la siguiente.`,
            );
            continue;
          }

          const sale = await readFalabellaSaleFromDetail(detailPage, candidate, this.config, {
            initialDetailMap: detailMap,
            onStep,
          });
          sales.push(sale);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error ?? "Error desconocido.");
          const compactMessage = message.split("\n")[0] ?? message;
          await onStep(
            `Orden ${candidate.externalId}: falló al abrir o leer el detalle en Falabella; la omito y sigo con la siguiente. ${compactMessage}`,
          );
        } finally {
          await detailPage.close().catch(() => undefined);
        }
      }
      await context.storageState({ path: this.authFilePath() });
      return sales;
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  async refreshSale(externalId: string, onStep: StepReporter, options?: FetchSalesOptions): Promise<Sale | undefined> {
    await onStep(`Refrescando la orden ${externalId} en Falabella`);

    const browser = await launchBrowser(this.config);
    const context = await newFalabellaContext(browser, this.authFilePath());
    const page = await context.newPage();

    try {
      await loginToFalabella(page, this.config.sellerCredentials, onStep, this.config.sellerPurchasedOrdersUrl);
      await openFalabellaDocumentsPage(page, this.config.sellerPurchasedOrdersUrl, this.config, onStep);
      const candidate = await findFalabellaPendingRowByOrderIdAcrossPages(
        page,
        externalId,
        onStep,
        options?.falabellaDocumentsSearchFromIso,
        options?.falabellaDocumentsSearchToIso,
      );
      if (!candidate) {
        return undefined;
      }

      const detailPage = await context.newPage();
      try {
        const detailMap = await waitForFalabellaOrderDetailReady(
          detailPage,
          candidate.detailUrl,
          this.config,
          candidate.externalId,
          onStep,
        );

        if (falabellaDetailIndicatesFactura(detailMap)) {
          await onStep(
            `Orden ${candidate.externalId}: en detalle «Documento tributario» es Factura; no hay boleta que refrescar.`,
          );
          return undefined;
        }

        const sale = await readFalabellaSaleFromDetail(detailPage, candidate, this.config, {
          initialDetailMap: detailMap,
          onStep,
        });
        await context.storageState({ path: this.authFilePath() });
        return sale;
      } finally {
        await detailPage.close().catch(() => undefined);
      }
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  async captureSaleEvidence(
    sale: Sale,
    attemptId: string,
    onStep: StepReporter,
  ): Promise<Artifact[]> {
    const detailUrl = String(sale.raw.detailUrl ?? "");

    if (!detailUrl) {
      return [];
    }

    await onStep(`Capturando evidencia en Falabella para ${sale.externalId}`);
    const browser = await launchBrowser(this.config);
    const context = await newFalabellaContext(browser, this.authFilePath());
    const page = await context.newPage();

    try {
      await loginToFalabella(page, this.config.sellerCredentials, onStep, detailUrl);
      await page.getByText(/Informaci[oó]n del cliente/i).first().waitFor({
        state: "visible",
        timeout: 30_000,
      });

      const screenshotPath = path.join(
        this.config.dataPaths.screenshotsDir,
        `${attemptId}-seller-detail.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await context.storageState({ path: this.authFilePath() });
      return [{ kind: "screenshot", path: screenshotPath }];
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  private authFilePath(): string {
    return path.join(
      this.config.dataPaths.authDir,
      accountScopedAuthFileName(this.accountId, "seller.json"),
    );
  }
}

export class SunatPortalEmitter implements InvoiceEmitter {
  private sunatSession?: { browser: Browser; context: BrowserContext };
  private sunatSessionPromise?: Promise<{ browser: Browser; context: BrowserContext }>;
  private invoicePage?: Page;
  private tracingActive = false;

  constructor(
    private readonly config: AppConfig,
    private readonly profile: SiteProfile,
    private readonly accountId?: string,
  ) {}

  async prepareSubmission(
    attemptId: string,
    draft: InvoiceDraft,
    onStep: StepReporter,
    submissionContext?: SubmissionContext,
  ): Promise<PreparedSubmission> {
    await onStep(`Abriendo el portal SUNAT para ${draft.saleExternalId}`);

    const { browser, context: browserContext } = await this.getOrCreateSunatSession();
    const { page, freshlyOpened } = await this.getOrOpenInvoicePage(browserContext, onStep);
    const tracePath = path.join(this.config.dataPaths.tracesDir, `${attemptId}.zip`);
    const preSubmitScreenshot = path.join(
      this.config.dataPaths.screenshotsDir,
      `${attemptId}-sunat-review.png`,
    );
    const errorScreenshot = path.join(
      this.config.dataPaths.screenshotsDir,
      `${attemptId}-sunat-error.png`,
    );

    try {
      if (!this.tracingActive) {
        await browserContext.tracing.start({ screenshots: true, snapshots: true });
        this.tracingActive = true;
      }
      await browserContext.tracing.startChunk().catch(() => undefined);
      let needsFreshLogin = freshlyOpened;
      if (!freshlyOpened) {
        await onStep(`Reutilizando sesión SUNAT y formulario abierto para ${draft.saleExternalId}.`);
        const ready = await tryWaitForAnyVisibleLocatorInPageTree(
          page,
          customerDocumentSelectors(this.profile.sunat.customerDocumentSelector),
          1_500,
        );
        if (!ready) {
          if (this.looksLikeSunatLoginPage(page)) {
            await onStep("La sesión SUNAT expiró; reabriré el navegador para reautenticar.");
            needsFreshLogin = true;
          } else {
            await onStep("Formulario de boleta no estaba listo; vuelvo a navegar el menú SOL.");
            await this.navigateToBoletaForm(page, onStep, 30_000);
          }
        }
      }

      if (needsFreshLogin) {
        await this.loginIfNeeded(page, onStep);
        await dismissSunatNotificationsPrompt(page, onStep);
        await this.navigateToBoletaForm(page, onStep, 90_000);
      }

      await onStep(`Llenando la factura SUNAT para ${draft.saleExternalId}`);
      if (this.profile.sunat.customerDocumentTypeSelector) {
        await onStep("Buscando el selector del tipo de documento del cliente.");
        const documentTypeField = await tryWaitForAnyVisibleLocatorInPageTree(
          page,
          customerDocumentTypeSelectors(this.profile.sunat.customerDocumentTypeSelector),
          10_000,
        );
        if (documentTypeField) {
          await onStep("Selector del tipo de documento encontrado; ajustando opción.");
          await ensureCustomerDocumentType(
            page,
            documentTypeField.locator,
            draft.customer.documentNumber,
            onStep,
          );
        } else {
          await onStep("No apareció un selector editable de tipo de documento; continúo con el flujo.");
        }
      }

      await onStep("Buscando el campo del número de documento del cliente.");
      const customerDocumentField = await waitForAnyVisibleLocatorInPageTree(
        page,
        customerDocumentSelectors(this.profile.sunat.customerDocumentSelector),
        15_000,
      );
      await onStep(`Campo documento encontrado (${await describeLocatorIdentity(customerDocumentField.locator)}).`);
      const writtenDocument = await fillSunatCustomerDocumentFieldExact(
        page,
        customerDocumentField.locator,
        draft.customer.documentNumber,
      );
      await customerDocumentField.locator.press("Tab").catch(() => undefined);
      await onStep(`Documento ingresado en SUNAT exactamente como quedó en el campo: ${writtenDocument || "(vacío)"}.`);
      await onStep("Documento ingresado; espero que SUNAT complete el nombre del cliente.");

      await onStep(`Validando nombre del cliente en SUNAT para ${draft.saleExternalId}`);
      const customerNameField = await waitForAutofilledCustomerName(
        page,
        customerNameSelectors(this.profile.sunat.customerNameSelector),
        draft.customer.name,
        customerDocumentField.scope,
        onStep,
        { profile: this.profile, draft },
      );

      await onStep("Buscando el primer botón Continuar de la boleta.");
      const continueButton = await tryWaitForBottomMostVisibleLocatorInPageTree(
        page,
        customerContinueSelectors(this.profile.sunat.customerContinueSelector ?? "text=Continuar"),
        6_000,
        customerNameField.scope,
      );
      if (continueButton) {
        await onStep("Encontré el primer Continuar y voy a hacer click.");
        await continueButton.locator.scrollIntoViewIfNeeded().catch(() => undefined);
        await continueButton.locator.click();
      } else {
        await onStep("No encontré el primer Continuar; seguiré con los campos visibles.");
      }

      if (this.profile.sunat.issueDateSelector) {
        await onStep("Revisando si la fecha de emisión se puede editar.");
        const issueDateField = await tryWaitForVisibleLocatorInPageTree(
          page,
          this.profile.sunat.issueDateSelector,
          2_000,
          customerNameField.scope,
        );
        if (issueDateField && (await issueDateField.locator.isEditable().catch(() => false))) {
          await onStep("Fecha de emisión editable encontrada; actualizando valor.");
          await issueDateField.locator.fill(draft.issueDate);
        }
      }

      if (this.profile.sunat.currencySelector) {
        await onStep("Revisando selector de moneda en SUNAT.");
        const currencyField = await tryWaitForVisibleLocatorInPageTree(
          page,
          this.profile.sunat.currencySelector,
          2_000,
          customerNameField.scope,
        );
        if (currencyField) {
          await onStep("Selector de moneda encontrado; intento aplicar la moneda del draft.");
          await currencyField.locator.selectOption(draft.currency).catch(() => undefined);
        }
      }

      if (this.profile.sunat.itemDialogSelector && this.profile.sunat.itemAcceptSelector) {
        await addItemsViaSunatModal(
          page,
          customerNameField.scope,
          draft,
          this.profile,
          this.config,
          onStep,
          validationWatcher,
        );
      } else {
        await ensureRowCount(
          customerNameField.scope,
          this.profile.sunat.itemRowSelector,
          draft.items.length,
          this.profile.sunat.addItemButtonSelector,
        );

        for (let index = 0; index < draft.items.length; index += 1) {
          const row = customerNameField.scope.locator(this.profile.sunat.itemRowSelector).nth(index);
          const item = draft.items[index];

          await row.locator(this.profile.sunat.itemDescriptionSelector).fill(item.description);
          await row
            .locator(this.profile.sunat.itemQuantitySelector)
            .fill(String(item.quantity));
          await row
            .locator(this.profile.sunat.itemUnitPriceSelector)
            .fill(String(item.unitPrice));
        }
      }

      await continueSunatBoletaWizard(page, this.profile, onStep);
      const preSubmitArtifacts: Artifact[] = [];
      if (this.config.debugArtifacts) {
        await page.screenshot({ path: preSubmitScreenshot, fullPage: true });
        preSubmitArtifacts.push({ kind: "screenshot", path: preSubmitScreenshot });
      }

      return new PendingSunatSubmission({
        attemptId,
        draft,
        browser,
        context: browserContext,
        page,
        tracePath,
        profile: this.profile,
        preSubmitArtifacts,
        config: this.config,
        sunatAuthFilePath: path.join(
          this.config.dataPaths.authDir,
          accountScopedAuthFileName(this.accountId, "sunat.json"),
        ),
        validationWatcher,
        releasePageForReuse: (reusablePage) => {
          this.reusableSunatPage = reusablePage;
        },
        onStep,
        runId: submissionContext?.runId,
        boletasDownloadDir: submissionContext?.boletasDownloadDir,
        releasePage: (outcome) => this.releaseInvoicePage(outcome),
      });
    } catch (error) {
      validationWatcher.stop();
      const artifacts: Artifact[] = [];
      if (!page.isClosed()) {
        await page.screenshot({ path: errorScreenshot, fullPage: true }).catch(() => undefined);
        if (fs.existsSync(errorScreenshot)) {
          artifacts.push({ kind: "screenshot", path: errorScreenshot });
        }
      }
      await stopTraceChunkSafely(browserContext, tracePath, artifacts);
      await this.discardInvoicePage();
      throw normalizeAutomationError(error, artifacts);
    }
  }

  async close(): Promise<void> {
    await this.discardInvoicePage();

    const session = this.sunatSession ?? (await this.sunatSessionPromise?.catch(() => undefined));
    this.sunatSession = undefined;
    this.sunatSessionPromise = undefined;

    if (!session) {
      return;
    }

    if (this.tracingActive) {
      await session.context.tracing.stop().catch(() => undefined);
      this.tracingActive = false;
    }
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
  }

  private async getOrOpenInvoicePage(
    browserContext: BrowserContext,
    onStep: StepReporter,
  ): Promise<{ page: Page; freshlyOpened: boolean }> {
    if (this.invoicePage && !this.invoicePage.isClosed()) {
      return { page: this.invoicePage, freshlyOpened: false };
    }

    const page = await browserContext.newPage();
    page.once("close", () => {
      if (this.invoicePage === page) {
        this.invoicePage = undefined;
      }
    });
    startSunatValidationIframeSearchLogger(page, onStep);
    this.invoicePage = page;
    return { page, freshlyOpened: true };
  }

  private looksLikeSunatLoginPage(page: Page): boolean {
    try {
      const url = page.url();
      return /api-seguridad\.sunat\.gob\.pe|loginMenuSol|AutenticaMenuInternet/i.test(url);
    } catch {
      return false;
    }
  }

  private async navigateToBoletaForm(
    page: Page,
    onStep: StepReporter,
    waitForFormMs: number,
  ): Promise<void> {
    if (this.profile.sunat.postLoginMenuLabels?.length) {
      await navigateSunatSolMenu(page, this.profile.sunat.postLoginMenuLabels, onStep);
      await waitForAnyVisibleLocatorInPageTree(
        page,
        customerDocumentSelectors(this.profile.sunat.customerDocumentSelector),
        waitForFormMs,
      );
    } else {
      await page.goto(this.profile.sunat.invoiceUrl, { waitUntil: "domcontentloaded" });
    }
  }

  private async releaseInvoicePage(outcome: "success" | "failed" | "cancelled"): Promise<void> {
    const page = this.invoicePage;
    if (!page || page.isClosed()) {
      this.invoicePage = undefined;
      return;
    }

    if (outcome !== "success") {
      await this.discardInvoicePage();
      return;
    }

    try {
      await page.goto(this.profile.sunat.invoiceUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch {
      await this.discardInvoicePage();
    }
  }

  private async discardInvoicePage(): Promise<void> {
    const page = this.invoicePage;
    this.invoicePage = undefined;
    if (page && !page.isClosed()) {
      await page.close().catch(() => undefined);
    }
  }

  private async loginIfNeeded(page: Page, onStep: StepReporter): Promise<void> {
    const authPath = path.join(
      this.config.dataPaths.authDir,
      accountScopedAuthFileName(this.accountId, "sunat.json"),
    );
    if (fs.existsSync(authPath)) {
      await onStep("SUNAT: encontré una sesión guardada; probaré primero el menú directo.");
      await page.goto(this.profile.sunat.invoiceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      if (await isLoggedIn(page, this.profile.sunat.login.loggedInSelector)) {
        return;
      }
      await onStep("SUNAT: la sesión guardada no alcanzó; haré login completo.");
    }

    await performLoginFlow({
      page,
      login: this.profile.sunat.login,
      credentials: this.config.sunatCredentials,
      onStep,
      stepLabel: "Autenticando en SUNAT",
    });
    await dismissSunatContactValidationSurface(page, onStep);
  }

  private async newContext(browser: Browser, authFileName: string): Promise<BrowserContext> {
    const authPath = path.join(this.config.dataPaths.authDir, authFileName);
    const context = fs.existsSync(authPath)
      ? await browser.newContext({ storageState: authPath })
      : await browser.newContext();

    await installSunatContactValidationModalDismisser(context);
    return context;
  }

  private async getOrCreateSunatSession(forceHeadful = false): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.sunatSession && this.sunatSession.browser.isConnected()) {
      if (forceHeadful && !this.sunatSessionIsHeadful) {
        await this.closeSunatSession();
      } else if (this.sunatSessionInvoiceCount >= this.config.sunatSessionMaxInvoices) {
        await this.closeSunatSession();
      } else {
        this.sunatSessionInvoiceCount += 1;
        return this.sunatSession;
      }
    }

    if (this.sunatSession && !this.sunatSession.browser.isConnected()) {
      this.sunatSession = undefined;
      this.sunatSessionInvoiceCount = 0;
    }

    if (this.sunatSession && this.sunatSession.browser.isConnected()) {
      this.sunatSessionInvoiceCount += 1;
      return this.sunatSession;
    }

    if (this.sunatSessionPromise) {
      return this.sunatSessionPromise;
    }

    this.sunatSessionPromise = (async () => {
      const browser = await chromium.launch({
        headless: !(SUNAT_REQUIRES_HEADFUL || forceHeadful || this.config.headful),
        slowMo: this.config.slowMoMs,
      });
      const context = await this.newContext(browser, accountScopedAuthFileName(this.accountId, "sunat.json"));
      const session = { browser, context };

      browser.once("disconnected", () => {
        if (this.sunatSession?.browser === browser) {
          this.sunatSession = undefined;
        }
      });
      context.once("close", () => {
        if (this.sunatSession?.context === context) {
          this.sunatSession = undefined;
        }
      });

      this.sunatSession = session;
      this.sunatSessionInvoiceCount = 1;
      this.sunatSessionIsHeadful = forceHeadful || this.config.headful;
      return session;
    })();

    try {
      return await this.sunatSessionPromise;
    } finally {
      this.sunatSessionPromise = undefined;
    }
  }

  private async closeSunatSession(): Promise<void> {
    const session = this.sunatSession ?? (await this.sunatSessionPromise?.catch(() => undefined));
    this.sunatSession = undefined;
    this.sunatSessionPromise = undefined;
    this.sunatSessionInvoiceCount = 0;
    this.sunatSessionIsHeadful = false;
    this.reusableSunatPage = undefined;

    if (!session) {
      return;
    }

    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
  }

  private takeReusableSunatPage(context: BrowserContext): Page | undefined {
    const page = this.reusableSunatPage;
    this.reusableSunatPage = undefined;
    if (!page || page.isClosed()) {
      return undefined;
    }
    return page.context() === context ? page : undefined;
  }
}

function startSunatValidationIframeSearchLogger(
  page: Page,
  onStep: StepReporter,
  options?: { initiallyPaused?: boolean },
): SunatValidationWatcherController {
  const POLL_INTERVAL_MS = SUNAT_TIMING.validationIframePollMs;
  let paused = options?.initiallyPaused ?? false;
  let stopped = false;

  const controller: SunatValidationWatcherController = {
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    stop: () => {
      stopped = true;
    },
    isPaused: () => paused,
  };

  void (async () => {
    while (!page.isClosed() && !stopped) {
      try {
        if (paused || (await shouldSuspendSunatValidationWatcher(page))) {
          await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => undefined);
          continue;
        }

        await onStep("SUNAT: buscando iframe #ifrVCE");
        const found = await page
          .evaluate(() => {
            const insideModal = document.querySelector("#divModalCampana #ifrVCE");
            if (insideModal instanceof HTMLIFrameElement) {
              return true;
            }

            const globalIframe = document.getElementById("ifrVCE");
            return globalIframe instanceof HTMLIFrameElement;
          })
          .catch(() => false);
        await onStep(found ? "SUNAT: iframe #ifrVCE encontrado" : "SUNAT: iframe #ifrVCE no encontrado");
        if (found) {
          await onStep("SUNAT: iframe #ifrVCE encontrado; haré una pausa corta antes de buscar los botones.");
          await page.waitForTimeout(SUNAT_TIMING.validationIframePostFoundPauseMs).catch(() => undefined);
          const finalized = await tryClickSunatValidationFinalizeButton(page, onStep);

          if (!finalized) {
            await onStep(
              "ERROR SUNAT: falló #btnFinalizarValidacionDatos; no cerraré el modal en este intento.",
            );
            continue;
          }

          const continued = await tryClickSunatValidationContinueWithoutConfirmButton(page, onStep);

          if (!continued) {
            await onStep("ERROR SUNAT: falló #btnCerrar; el modal sigue abierto.");
            continue;
          }

          if (finalized && continued) {
            await onStep("SUNAT: iframe resuelto; detengo la búsqueda del modal.");
            return;
          }
        }
      } catch {
        return;
      }

      await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => undefined);
    }
  })();

  return controller;
}

async function shouldSuspendSunatValidationWatcher(page: Page): Promise<boolean> {
  const selectors = [
    "#dialogItem",
    "#numeroComprobante",
    "#dijit_form_Button_2_label",
    ...finalSubmitSelectors("#boleta-preliminar\\.botonGrabarDocumento"),
  ];

  return isAnyVisibleLocatorInPageTree(page, selectors);
}

async function tryClickSunatValidationFinalizeButton(
  page: Page,
  onStep: StepReporter,
): Promise<boolean> {
  await onStep("SUNAT: buscando #btnFinalizarValidacionDatos dentro del iframe");

  for (const frame of page.frames()) {
    const hasButton = await frame
      .evaluate(() => Boolean(document.getElementById("btnFinalizarValidacionDatos")))
      .catch(() => false);

    if (!hasButton) {
      continue;
    }

    const finalizeButton = frame.locator("#btnFinalizarValidacionDatos").first();
    const isVisible = await finalizeButton.isVisible().catch(() => false);

    if (!isVisible) {
      await onStep("SUNAT: #btnFinalizarValidacionDatos encontrado en el iframe, pero no esta visible");
      return false;
    }

    await onStep("SUNAT: #btnFinalizarValidacionDatos encontrado; haré click");
    await finalizeButton.scrollIntoViewIfNeeded().catch(() => undefined);
    const clicked = await finalizeButton.click().then(() => true).catch(() => false);
    if (!clicked) {
      await onStep("SUNAT: falló el click en #btnFinalizarValidacionDatos; seguiré buscando.");
      return false;
    }
    await page.waitForTimeout(SUNAT_TIMING.itemDialogPollMs).catch(() => undefined);
    return true;
  }

  await onStep("SUNAT: #btnFinalizarValidacionDatos no encontrado dentro del iframe");
  return false;
}

async function tryClickSunatValidationContinueWithoutConfirmButton(
  page: Page,
  onStep: StepReporter,
): Promise<boolean> {
  await onStep("SUNAT: buscando #btnCerrar dentro del iframe");

  for (const frame of page.frames()) {
    const hasButton = await frame.evaluate(() => Boolean(document.getElementById("btnCerrar"))).catch(() => false);

    if (!hasButton) {
      continue;
    }

    const closeButton = frame.locator("#btnCerrar").first();
    const isVisible = await closeButton.isVisible().catch(() => false);

    if (!isVisible) {
      await onStep("SUNAT: #btnCerrar encontrado en el iframe, pero no esta visible");
      return false;
    }

    await onStep("SUNAT: #btnCerrar encontrado; haré click en Continuar sin confirmar");
    await closeButton.scrollIntoViewIfNeeded().catch(() => undefined);
    const clicked = await closeButton.click().then(() => true).catch(() => false);
    if (!clicked) {
      await onStep("SUNAT: falló el click en #btnCerrar; seguiré buscando.");
      return false;
    }
    await page.waitForTimeout(SUNAT_TIMING.itemDialogPollMs).catch(() => undefined);
    return true;
  }

  await onStep("SUNAT: #btnCerrar no encontrado dentro del iframe");
  return false;
}

class PendingSunatSubmission implements PreparedSubmission {
  private cleanupStarted = false;
  private keepPageForReuse = false;
  private readonly interruptionSignal: Promise<string>;
  private resolveInterruption?: (message: string) => void;

  constructor(
    private readonly params: {
      attemptId: string;
      draft: InvoiceDraft;
      browser: Browser;
      context: BrowserContext;
      page: Page;
      tracePath: string;
      profile: SiteProfile;
      preSubmitArtifacts: Artifact[];
      config: AppConfig;
      sunatAuthFilePath: string;
      validationWatcher: SunatValidationWatcherController;
      releasePageForReuse?: (page: Page) => void;
      onStep: StepReporter;
      runId?: string;
      boletasDownloadDir?: string;
      releasePage: (outcome: "success" | "failed" | "cancelled") => Promise<void>;
    },
  ) {
    this.interruptionSignal = new Promise<string>((resolve) => {
      this.resolveInterruption = resolve;
    });

    const notifyOperatorClosure = () => {
      if (this.cleanupStarted) {
        return;
      }

      this.resolveInterruption?.("Flujo cancelado porque el operador cerró el navegador.");
    };

    this.params.page.once("close", notifyOperatorClosure);
    this.params.browser.once("disconnected", notifyOperatorClosure);
  }

  get preSubmitArtifacts(): Artifact[] {
    return this.params.preSubmitArtifacts;
  }

  waitForInterruption(): Promise<string> {
    return this.interruptionSignal;
  }

  async submit(onStep: StepReporter): Promise<{
    artifacts: Artifact[];
    receiptNumber?: string;
    receiptPrefix?: string;
  }> {
    const confirmationScreenshot = path.join(
      this.params.config.dataPaths.screenshotsDir,
      `${this.params.attemptId}-sunat-confirmation.png`,
    );
    const artifacts: Artifact[] = [];

    try {
      await onStep("Enviando factura en SUNAT");
      this.params.validationWatcher.resume();
      await continueSunatBoletaWizard(this.params.page, this.params.profile, onStep, {
        allowImmediateFinalStage: true,
      });

      await onStep("Buscando el botón Emitir de la preliminar.");
      const submitButton = await waitForAnyVisibleLocatorInPageTree(
        this.params.page,
        this.params.profile.sunat.finalSubmitSelector,
        15_000,
      );
      await onStep(`Botón Emitir encontrado (${await describeLocatorIdentity(submitButton.locator)}); haré click.`);
      await clickSunatAction(this.params.page, submitButton.locator, onStep, "Emitir");
      await onStep("Click en Emitir realizado; esperando la confirmación.");
      await waitForSunatProcessingToSettle(this.params.page, "la emisión preliminar", onStep, 25_000);

      if (this.params.profile.sunat.confirmAcceptSelector) {
        await onStep("Esperando el botón Aceptar de la confirmación.");
        const acceptButton = await waitForVisibleLocatorInPageTree(
          this.params.page,
          this.params.profile.sunat.confirmAcceptSelector,
          1500,
        );
        await onStep(`Botón Aceptar encontrado (${await describeLocatorIdentity(acceptButton.locator)}); haré click.`);
        await acceptButton.locator.click();
        await onStep("Click en Aceptar realizado; esperando el comprobante emitido.");
        await waitForSunatProcessingToSettle(this.params.page, "la confirmación de emisión", onStep, 5000);
      }

      await this.params.page.waitForLoadState("domcontentloaded").catch(() => undefined);

      if (
        this.params.profile.sunat.validationErrorSelector &&
        (await this.params.page
          .locator(this.params.profile.sunat.validationErrorSelector)
          .count()) > 0
      ) {
        const validation = await this.params.page
          .locator(this.params.profile.sunat.validationErrorSelector)
          .first()
          .textContent();
        throw new AutomationError(validation?.trim() || "SUNAT devolvió un error de validación.", artifacts);
      }

      await onStep("Esperando el número de comprobante emitido.");
      const successMarker = await waitForVisibleLocatorInPageTree(
        this.params.page,
        this.params.profile.sunat.successSelector,
        25_000,
      );
      await onStep(`Pantalla final detectada (${await describeLocatorIdentity(successMarker.locator)}).`);
      if (this.params.config.debugArtifacts) {
        await this.params.page.screenshot({ path: confirmationScreenshot, fullPage: true });
        artifacts.push({ kind: "screenshot", path: confirmationScreenshot });
      }
      await this.params.context.storageState({
        path: this.params.sunatAuthFilePath,
      });

      await onStep("Leyendo el número de comprobante emitido.");
      const receiptInfo = await readSunatReceiptInfo(this.params.page, this.params.profile);
      await onStep(`Comprobante leído: ${receiptInfo.receiptNumber}.`);
      await onStep(`Prefijo del comprobante detectado: ${receiptInfo.receiptPrefix}.`);
      await onStep(
        `Carpeta de boletas de esta corrida: ${this.params.boletasDownloadDir ?? path.join(this.params.config.dataPaths.rootDir, "boletas-descargadas")}.`,
      );
      const downloadedFiles = await downloadSunatReceiptFiles(
        this.params.page,
        this.params.profile,
        this.params.config,
        {
          saleExternalId: this.params.draft.saleExternalId,
          customerDocumentNumber: this.params.draft.customer.documentNumber,
          receiptPrefix: receiptInfo.receiptPrefix,
          boletasDownloadDir: this.params.boletasDownloadDir,
        },
        onStep,
      );
      artifacts.push(...downloadedFiles.map((path) => ({ kind: "file" as const, path })));

      if (this.params.profile.sunat.closeSuccessSelector) {
        const closeButton = await tryWaitForVisibleLocatorInPageTree(
          this.params.page,
          this.params.profile.sunat.closeSuccessSelector,
          3_000,
        );
        if (closeButton) {
          await closeButton.locator.click().catch(() => undefined);
        }
      }

      await stopTraceChunkSafely(this.params.context, this.params.tracePath, artifacts);
      await this.cleanup("success");

      return {
        artifacts,
        receiptNumber: receiptInfo.receiptNumber,
        receiptPrefix: receiptInfo.receiptPrefix,
      };
    } catch (error) {
      const failureScreenshot = path.join(
        this.params.config.dataPaths.screenshotsDir,
        `${this.params.attemptId}-sunat-submit-error.png`,
      );
      await this.params.page
        .screenshot({ path: failureScreenshot, fullPage: true })
        .catch(() => undefined);
      if (fs.existsSync(failureScreenshot)) {
        artifacts.push({ kind: "screenshot", path: failureScreenshot });
      }
      await stopTraceChunkSafely(this.params.context, this.params.tracePath, artifacts);
      await this.cleanup("failed");
      throw normalizeAutomationError(error, artifacts);
    }
  }

  async cancel(onStep: StepReporter): Promise<Artifact[]> {
    const cancellationScreenshot = path.join(
      this.params.config.dataPaths.screenshotsDir,
      `${this.params.attemptId}-sunat-cancelled.png`,
    );
    const artifacts: Artifact[] = [];

    await onStep("Cancelando el envío pendiente en SUNAT");
    await this.params.page.screenshot({ path: cancellationScreenshot, fullPage: true }).catch(() => undefined);

    if (fs.existsSync(cancellationScreenshot)) {
      artifacts.push({ kind: "screenshot", path: cancellationScreenshot });
    }

    await stopTraceChunkSafely(this.params.context, this.params.tracePath, artifacts);
    await this.cleanup("cancelled");
    return artifacts;
  }

  private async cleanup(outcome: "success" | "failed" | "cancelled"): Promise<void> {
    this.cleanupStarted = true;
    await this.params.releasePage(outcome).catch(() => undefined);
  }
}

type FalabellaRowCandidate = {
  externalId: string;
  detailUrl: string;
  issuedAt: string;
  documentProgress: string;
  uploadedDocuments: number;
  totalDocuments: number;
  requestedDocumentType?: string;
  itemDocumentTypes: Array<{
    description: string;
    documentType?: string;
  }>;
};

const FALABELLA_LOCAL_STORAGE_ENTRIES = [
  ["user-coach-mark", "4"],
  [
    "common-coach-mark",
    JSON.stringify([
      ".support-coachmark",
      ".col_0_0",
      ".col_0_2",
      ".col_1_0",
      ".col_2_0",
      ".col_3_0",
    ]),
  ],
] as const;

/** Título del modal de encuesta (texto del `<p>` en Seller Center). */
const FALABELLA_DOCUMENT_UPLOAD_FEEDBACK_TITLE =
  "Qué te parece la experiencia de carga de documentos tributarios?";

/** Subcadena estable por si acortan o cambian el encabezado. */
const FALABELLA_DOCUMENT_UPLOAD_FEEDBACK_MARKER = "experiencia de carga de documentos tributarios";

const FALABELLA_DOCUMENT_UPLOAD_FEEDBACK_TEXT_MARKERS = [
  FALABELLA_DOCUMENT_UPLOAD_FEEDBACK_TITLE,
  FALABELLA_DOCUMENT_UPLOAD_FEEDBACK_MARKER,
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function launchBrowser(config: AppConfig): Promise<Browser> {
  return chromium.launch({
    headless: !config.headful,
    slowMo: config.slowMoMs,
  });
}

async function newFalabellaContext(browser: Browser, authPath?: string): Promise<BrowserContext> {
  void authPath;
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript((entries) => {
    const hn = window.location.hostname.toLowerCase();
    if (!(hn.includes("sellercenter") && hn.includes("falabella"))) {
      return;
    }

    for (const [key, value] of entries) {
      window.localStorage.setItem(key, value);
    }
  }, FALABELLA_LOCAL_STORAGE_ENTRIES);

  await context.addInitScript((markers: readonly string[]) => {
    if (typeof window === "undefined") {
      return;
    }
    const hn = window.location.hostname.toLowerCase();
    if (!(hn.includes("sellercenter") && hn.includes("falabella"))) {
      return;
    }

    const installKey = "__automateSunatFalabellaFeedbackDismiss";
    const winFlags = window as unknown as Record<string, unknown>;
    if (winFlags[installKey]) {
      return;
    }
    winFlags[installKey] = true;

    try {
      const style = document.createElement("style");
      style.textContent = `
        #survey-wrapper {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
          z-index: -9999 !important;
        }
      `;
      document.head.appendChild(style);
    } catch {
      /* ignore */
    }

    function foldAccents(s: string): string {
      try {
        return s.normalize("NFD").replace(/\p{M}/gu, "");
      } catch {
        return s;
      }
    }

    function haystackMatchesFeedbackModal(haystack: string): boolean {
      const folded = foldAccents(haystack.toLowerCase());
      for (let i = 0; i < markers.length; i++) {
        const needle = foldAccents(String(markers[i]).toLowerCase());
        if (needle.length > 0 && folded.includes(needle)) {
          return true;
        }
      }
      return false;
    }

    function hideModalMaskForWrap(wrap: Element): void {
      const root = wrap.closest(".ant-modal-root");
      if (!root) {
        return;
      }
      const mask = root.querySelector(":scope > .ant-modal-mask");
      if (mask instanceof HTMLElement) {
        mask.style.display = "none";
      }
    }

    function forceHideFeedbackEl(el: HTMLElement): void {
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
      el.setAttribute("aria-hidden", "true");
    }

    function dispatchUiClick(el: HTMLElement): void {
      el.click();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }

    function normBtnLabel(el: Element): string {
      return (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    function tryDismissFeedbackInRoot(root: Element): boolean {
      const text = root.textContent || "";
      if (!haystackMatchesFeedbackModal(text)) {
        return false;
      }

      const shell =
        root instanceof HTMLElement
          ? root.closest(".settlement-invoice-modal-wrap") ?? root
          : null;
      const clickRoot: Element =
        root instanceof HTMLElement ? root.querySelector(".settlement-invoice-modal") ?? root : root;

      const cancelPrimary = clickRoot.querySelector(
        ".settlement-invoice-modal-footer .settlement-invoice-btn-default",
      );
      if (cancelPrimary instanceof HTMLElement) {
        dispatchUiClick(cancelPrimary);
      }

      const footerCancel = clickRoot.querySelector(".settlement-invoice-modal-footer button");
      if (
        footerCancel instanceof HTMLElement &&
        footerCancel !== cancelPrimary &&
        normBtnLabel(footerCancel) === "cancelar"
      ) {
        dispatchUiClick(footerCancel);
      }

      const buttons = clickRoot.querySelectorAll("button");
      for (let j = 0; j < buttons.length; j++) {
        const btn = buttons[j];
        if (!(btn instanceof HTMLElement)) {
          continue;
        }
        const label = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (label === "cancelar") {
          dispatchUiClick(btn);
          break;
        }
      }

      const closeBtn = clickRoot.querySelector(
        ".settlement-invoice-modal-close, button[aria-label='Close'], .ant-modal-close, .ant-modal-close-x",
      );
      if (closeBtn instanceof HTMLElement) {
        dispatchUiClick(closeBtn);
      }

      if (shell instanceof HTMLElement) {
        hideModalMaskForWrap(shell);
        forceHideFeedbackEl(shell);
        shell.remove();
        return true;
      }

      if (root instanceof HTMLElement) {
        hideModalMaskForWrap(root);
        forceHideFeedbackEl(root);
        root.remove();
        return true;
      }

      return false;
    }

    function pickerPanelLooksVisible(el: HTMLElement): boolean {
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }

    function classNameOf(el: Element): string {
      const cn = el.className;
      return typeof cn === "string" ? cn : "";
    }

    /** true si el nodo está bajo el popup del selector de fechas (no el modal de encuesta). */
    function isUnderDatePickerUi(el: Element | null): boolean {
      for (let d = 0, c: Element | null = el; d < 28 && c; d += 1, c = c.parentElement) {
        const cls = classNameOf(c);
        if (
          cls.includes("settlement-invoice-picker") ||
          /\bant-picker\b/.test(cls) ||
          cls.includes("ant-picker-dropdown") ||
          cls.includes("ant-picker-panel")
        ) {
          return true;
        }
      }
      return false;
    }

    function hostLooksLikeCalendarGrid(el: HTMLElement): boolean {
      const cells =
        el.querySelectorAll("td.settlement-invoice-picker-cell, td.ant-picker-cell, .settlement-invoice-picker-cell")
          .length;
      return cells >= 7;
    }

    function scheduleForceHidePicker(host: HTMLElement): void {
      const outer =
        host.closest(".ant-picker-dropdown") ??
        host.closest("[class*='settlement-invoice-picker']") ??
        host.closest(".ant-picker-panel-container") ??
        host;

      window.setTimeout(() => {
        if (!pickerPanelLooksVisible(host)) {
          return;
        }
        if (outer instanceof HTMLElement) {
          forceHideFeedbackEl(outer);
        }
        window.setTimeout(() => {
          if (pickerPanelLooksVisible(host) && outer instanceof HTMLElement) {
            forceHideFeedbackEl(outer);
          }
        }, 400);
      }, 200);
    }

    /** Cierra calendarios / rangos de fechas abiertos (Falabella usa variantes Ant; no siempre el mismo wrapper). */
    function dismissStuckFalabellaDatePopups(): void {
      try {
        const candidateSelectors = [
          ".settlement-invoice-picker-panel-container",
          ".ant-picker-dropdown",
          ".ant-picker-panel-container",
          ".ant-picker-range-wrapper",
        ];

        const tryHost = (host: HTMLElement) => {
          if (!pickerPanelLooksVisible(host)) {
            return;
          }
          const r = host.getBoundingClientRect();
          if (r.width < 72 || r.height < 72) {
            return;
          }
          if (!isUnderDatePickerUi(host) && !hostLooksLikeCalendarGrid(host)) {
            return;
          }

          const footerBtnSelectors = [
            ".settlement-invoice-picker-footer button",
            ".ant-picker-footer button",
            ".ant-picker-ranges button",
            ".ant-picker-ok button",
          ].join(", ");

          const footerBtns = host.querySelectorAll(footerBtnSelectors);
          for (let b = 0; b < footerBtns.length; b++) {
            const btn = footerBtns[b];
            if (!(btn instanceof HTMLElement)) {
              continue;
            }
            if (!isUnderDatePickerUi(btn)) {
              continue;
            }
            const lbl = normBtnLabel(btn);
            if (lbl === "cerrar" || lbl === "ok" || lbl === "aceptar" || lbl === "aplicar") {
              dispatchUiClick(btn);
              break;
            }
          }

          scheduleForceHidePicker(host);
        };

        for (let s = 0; s < candidateSelectors.length; s++) {
          const nodes = document.querySelectorAll(candidateSelectors[s]);
          for (let i = 0; i < nodes.length; i++) {
            const h = nodes[i];
            if (h instanceof HTMLElement) {
              tryHost(h);
            }
          }
        }

        const allButtons = document.querySelectorAll("button");
        for (let i = 0; i < allButtons.length; i++) {
          const btn = allButtons[i];
          if (!(btn instanceof HTMLElement) || !pickerPanelLooksVisible(btn)) {
            continue;
          }
          if (normBtnLabel(btn) !== "cerrar") {
            continue;
          }
          if (!isUnderDatePickerUi(btn)) {
            continue;
          }
          dispatchUiClick(btn);
          const lift = btn.closest(".ant-picker-dropdown") ?? btn.closest("[class*='settlement-invoice-picker']");
          if (lift instanceof HTMLElement) {
            scheduleForceHidePicker(lift);
          }
        }
      } catch {
        /* ignore */
      }
    }

    function dismissMedalliaSurveyWrapper(): void {
      try {
        const wrap = document.getElementById("survey-wrapper");
        if (!(wrap instanceof HTMLElement)) {
          return;
        }

        const form = wrap.querySelector("form.mediumSurvey");
        const txt = foldAccents((wrap.textContent || "").toLowerCase());
        if (!form && !txt.includes("falabella")) {
          return;
        }

        const cerrar = wrap.querySelector(
          'button[data-aut="button-close"], button.surveyBtn_close, button.surveyBtn.surveyBtn_close',
        );
        if (cerrar instanceof HTMLElement && normBtnLabel(cerrar) === "cerrar") {
          dispatchUiClick(cerrar);
        }

        const xBtn = wrap.querySelector('button[data-aut="button-x-close"], button.surveyX, button[aria-label="Close Survey"]');
        if (xBtn instanceof HTMLElement) {
          dispatchUiClick(xBtn);
        }

        forceHideFeedbackEl(wrap);
        wrap.remove();
      } catch {
        /* ignore */
      }
    }

    function dismissDocumentUploadFeedbackModal(): void {
      try {
        const outerInvoiceWraps = document.querySelectorAll(".settlement-invoice-modal-wrap");
        for (let w = 0; w < outerInvoiceWraps.length; w++) {
          if (tryDismissFeedbackInRoot(outerInvoiceWraps[w])) {
            return;
          }
        }

        const wraps = document.querySelectorAll(".ant-modal-wrap");
        for (let i = 0; i < wraps.length; i++) {
          if (tryDismissFeedbackInRoot(wraps[i])) {
            return;
          }
        }

        const settlementModals = document.querySelectorAll(".settlement-invoice-modal");
        for (let k = 0; k < settlementModals.length; k++) {
          if (tryDismissFeedbackInRoot(settlementModals[k])) {
            return;
          }
        }
      } catch {
        /* ignore */
      }
    }

    function dismissFalabellaBlockingOverlays(): void {
      dismissDocumentUploadFeedbackModal();
      dismissMedalliaSurveyWrapper();
      dismissStuckFalabellaDatePopups();
    }

    function attachObserver(): void {
      if (!document.body) {
        return;
      }
      const observer = new MutationObserver(() => {
        dismissFalabellaBlockingOverlays();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      dismissFalabellaBlockingOverlays();
      window.setInterval(dismissFalabellaBlockingOverlays, 2_000);
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attachObserver, { once: true });
    } else {
      attachObserver();
    }
  }, FALABELLA_DOCUMENT_UPLOAD_FEEDBACK_TEXT_MARKERS);

  return context;
}

/** Campo de contraseña visible en el login (Falabella cambia marcado; no siempre es `#password`). */
async function findVisibleFalabellaLoginPasswordField(page: Page): Promise<Locator | undefined> {
  const candidates: Locator[] = [
    page.getByLabel(/^password$/i),
    page.locator("#password"),
    page.locator('input[type="password"]'),
    page.locator('input[name="password" i]'),
  ];

  for (const candidate of candidates) {
    const field = candidate.first();
    if (await field.isVisible().catch(() => false)) {
      return field;
    }
  }

  return undefined;
}

async function loginToFalabella(
  page: Page,
  credentials: { username: string; password: string },
  onStep: StepReporter,
  /** Primera carga y destino tras autenticar (p. ej. Documentos tributarios o URL de detalle de orden). */
  entryUrl: string,
): Promise<void> {
  await onStep("Autenticando en Falabella Seller Center");
  await onStep("Falabella login: abriendo la URL de destino en Seller Center (domcontentloaded, hasta 60s).");
  await page.goto(entryUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await persistFalabellaLocalStorage(page);
  const emailField = page.locator("#email").first();
  const ordersMenu = page.getByRole("link", { name: /Órdenes/i }).first();
  const passwordRaceLocator = page.locator("#password, input[type='password']").first();

  await onStep(
    "Falabella login: buscando uno de: campo #email, contraseña o enlace Órdenes (espera hasta 8s).",
  );
  await Promise.race([
    emailField.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined),
    passwordRaceLocator.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined),
    ordersMenu.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined),
  ]);

  if (await emailField.isVisible().catch(() => false)) {
    await onStep(`Falabella login: rellenando email seleccionado: ${credentials.username}.`);
    await emailField.fill("");
    await emailField.fill(credentials.username);
    const filledEmail = await emailField.inputValue().catch(() => "");
    if (filledEmail.trim().toLowerCase() !== credentials.username.trim().toLowerCase()) {
      throw new AutomationError(
        `Falabella login: el campo email quedó con "${filledEmail}" pero la cuenta seleccionada es "${credentials.username}".`,
      );
    }

    let passwordField = await findVisibleFalabellaLoginPasswordField(page);

    if (!passwordField) {
      await onStep(
        "Falabella login: contraseña aún no visible; pulso #submit para el paso de password (si aplica).",
      );
      await page.locator("#submit").first().click({ noWaitAfter: true }).catch(() => undefined);
      await onStep("Falabella login: esperando campo de contraseña visible (hasta 30s).");
      const deadline = Date.now() + 30_000;
      while (!passwordField && Date.now() < deadline) {
        await page.waitForTimeout(300);
        passwordField = await findVisibleFalabellaLoginPasswordField(page);
      }
    }
  }

  let passwordField = await findVisibleFalabellaLoginPasswordField(page);

  if (passwordField) {
    if (!String(credentials.password ?? "").trim()) {
      await onStep(
        "Falabella login: advertencia — la contraseña en configuración está vacía; no puedo iniciar sesión.",
      );
    } else {
      await onStep("Falabella login: rellenando contraseña.");
      await passwordField.click({ timeout: 5_000 }).catch(() => undefined);
      await passwordField.fill(credentials.password);
    }

    const signInButton = page
      .getByRole("button", { name: /Iniciar sesi[oó]n|Sign in|Login|Entrar/i })
      .first();
    await onStep(
      "Falabella login: buscando botón de envío (Iniciar sesión / Login / Sign in / Entrar) y haciendo click.",
    );
    await signInButton.click({ noWaitAfter: true }).catch(() => undefined);
    await waitForFalabellaPostLogin(page, 8_000);

    passwordField = await findVisibleFalabellaLoginPasswordField(page);
    if (passwordField && (await passwordField.isVisible().catch(() => false))) {
      await onStep("Falabella login: el formulario sigue visible; reintento click en botón de inicio de sesión.");
      await signInButton.click({ noWaitAfter: true }).catch(() => undefined);
      await waitForFalabellaPostLogin(page, 8_000);
    }
  }

  await waitForFalabellaPostLogin(page, 8_000);

  await onStep("Falabella login: sesión lista; vuelvo a la URL de destino en Seller Center.");
  await page.goto(entryUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await persistFalabellaLocalStorage(page);
}


async function openFalabellaDocumentsPage(
  page: Page,
  url: string,
  config: AppConfig,
  onStep: StepReporter,
): Promise<void> {
  await onStep("Abriendo Documentos tributarios en Falabella");

  if (!isFalabellaDocumentsUrl(page.url())) {
    await onStep(
      "Falabella documentos: aún no estoy en Documentos tributarios; navego a la URL configurada (60s).",
    );
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await persistFalabellaLocalStorage(page);
  } else {
    await onStep("Falabella documentos: ya cargué la URL de Documentos tributarios tras el login; esperando la tabla.");
  }

  if (await isFalabellaLoginSurface(page)) {
    await onStep("Falabella documentos: detecté un retorno al login; reautentico antes de esperar la tabla.");
    await loginToFalabella(page, config.sellerCredentials, onStep, url);
  }

  await onStep(
    "Falabella documentos: esperando tabla de órdenes o lista vacía (hasta 25s).",
  );
  let readyState = await waitForFalabellaDocumentsReadyState(page, onStep, 25_000);
  if (readyState === "rows" || readyState === "empty") {
    return;
  }

  await onStep("Falabella documentos: la vista no quedó lista; reintento page.goto a la misma URL (60s).");
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await persistFalabellaLocalStorage(page);
  if (await isFalabellaLoginSurface(page)) {
    await onStep("Falabella documentos: tras el reintento seguí en login; vuelvo a autenticar antes de medir la tabla.");
    await loginToFalabella(page, config.sellerCredentials, onStep, url);
  }

  readyState = await waitForFalabellaDocumentsReadyState(page, onStep, 25_000);
  if (readyState === "timeout") {
    await logFalabellaDocumentsPageFailure(page, config, onStep);
    throw new Error("Falabella no mostró la tabla de Documentos tributarios a tiempo.");
  }
}

async function isFalabellaLoginSurface(page: Page): Promise<boolean> {
  if (/sellercenter\.falabella\.com\/user\/auth\/login/i.test(page.url())) {
    return true;
  }

  const emailVisible = await page.locator("#email").first().isVisible().catch(() => false);
  if (emailVisible) {
    return true;
  }

  return page.locator("#password, input[type='password']").first().isVisible().catch(() => false);
}

async function logFalabellaDocumentsPageFailure(
  page: Page,
  config: AppConfig,
  onStep: StepReporter,
): Promise<void> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = ((await page.locator("body").textContent().catch(() => "")) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const bodySnippet = bodyText ? truncateForLog(bodyText, 280) : "sin texto visible";
  const screenshotPath = path.join(
    config.dataPaths.screenshotsDir,
    `falabella-documents-timeout-${Date.now()}.png`,
  );

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  await onStep(
    `Falabella documentos timeout: URL=${url || "sin URL"} · title=${title || "sin title"} · texto=${bodySnippet}.`,
  );
  if (fs.existsSync(screenshotPath)) {
    await onStep(`Falabella documentos timeout: screenshot guardado en ${screenshotPath}.`);
  }
}

type FalabellaPaginationState = {
  currentPage: number;
  totalPages: number;
  hasNextPage: boolean;
  nextPage?: number;
};

function getFalabellaTodayLocalIso(): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/**
 * Ventanas de 30 días corridos inclusivos (inicio + 29), encadenadas con el último día del bloque
 * anterior como primer día del siguiente (p. ej. 1–30 ene, 30 ene–28 feb, 28 feb–29 mar).
 * El filtro en Falabella sigue partiéndose por mes calendario dentro de cada ventana.
 */
const FALABELLA_DOCUMENTS_DATE_CHUNK_DAYS = 30;

function parseFalabellaLocalIsoDate(iso: string): { y: number; m: number; d: number } {
  const parts = iso.split("-").map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Falabella documentos: fecha ISO inválida "${iso}".`);
  }
  const [y, m, d] = parts;
  return { y, m, d };
}

function formatFalabellaLocalIsoDate(y: number, m: number, d: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}

function falabellaIsoSameCalendarMonth(isoA: string, isoB: string): boolean {
  const a = parseFalabellaLocalIsoDate(isoA);
  const b = parseFalabellaLocalIsoDate(isoB);
  return a.y === b.y && a.m === b.m;
}

function addCalendarDaysToFalabellaIsoLocal(iso: string, deltaDays: number): string {
  const { y, m, d } = parseFalabellaLocalIsoDate(iso);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return formatFalabellaLocalIsoDate(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/** Último día del mes local; `m` es 1–12. */
function falabellaEndOfCalendarMonthIso(y: number, m: number): string {
  const last = new Date(y, m, 0);
  return formatFalabellaLocalIsoDate(last.getFullYear(), last.getMonth() + 1, last.getDate());
}

/**
 * Parte [rangeStart, rangeEnd] en intervalos dentro de un solo mes (fin de mes como tope).
 * Recorre el mismo conjunto de días que el rango original, sin solapamientos.
 */
function* subdivideFalabellaIsoRangeByCalendarMonth(
  rangeStartIso: string,
  rangeEndIso: string,
): Generator<{ start: string; end: string }> {
  if (rangeStartIso.localeCompare(rangeEndIso) > 0) {
    return;
  }

  let cursor = rangeStartIso;
  while (cursor.localeCompare(rangeEndIso) <= 0) {
    const { y, m } = parseFalabellaLocalIsoDate(cursor);
    const monthLast = falabellaEndOfCalendarMonthIso(y, m);
    const segmentEnd = monthLast.localeCompare(rangeEndIso) <= 0 ? monthLast : rangeEndIso;
    yield { start: cursor, end: segmentEnd };
    cursor = addCalendarDaysToFalabellaIsoLocal(segmentEnd, 1);
  }
}

function* iterateFalabellaDateChunksFromYearStart(
  year: number,
  todayIso: string,
): Generator<{ start: string; end: string }> {
  const fromJan1 = formatFalabellaLocalIsoDate(year, 1, 1);
  yield* iterateFalabellaDateChunksFromRangeStart(fromJan1, todayIso);
}

function* iterateFalabellaDateChunksFromRangeStart(
  rangeStartIso: string,
  todayIso: string,
): Generator<{ start: string; end: string }> {
  if (rangeStartIso.localeCompare(todayIso) > 0) {
    return;
  }

  let chunkStart = rangeStartIso;
  while (chunkStart.localeCompare(todayIso) <= 0) {
    const chunkEndInclusive = addCalendarDaysToFalabellaIsoLocal(
      chunkStart,
      FALABELLA_DOCUMENTS_DATE_CHUNK_DAYS - 1,
    );
    const end = chunkEndInclusive.localeCompare(todayIso) > 0 ? todayIso : chunkEndInclusive;
    yield { start: chunkStart, end };
    if (end.localeCompare(todayIso) >= 0) {
      return;
    }
    chunkStart = end;
  }
}

type FalabellaDatePickerFlavor = "settlement" | "ant";

function falabellaMonthLabelToNumber(raw: string): number | undefined {
  const t = raw.trim().toLowerCase().replace(/\./g, "");
  const fullEs: Record<string, number> = {
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    setiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12,
  };
  if (fullEs[t] !== undefined) {
    return fullEs[t];
  }
  const k3 = t.slice(0, 3);
  const abbrevs: Record<string, number> = {
    ene: 1,
    feb: 2,
    mar: 3,
    abr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    ago: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dic: 12,
    jan: 1,
    apr: 4,
    aug: 8,
    dec: 12,
  };
  return abbrevs[k3];
}

async function readSettlementPickerPanelYearMonth(panel: Locator): Promise<{ y: number; m: number } | null> {
  const monthRaw = await panel
    .locator(".settlement-invoice-picker-month-btn")
    .first()
    .textContent()
    .catch(() => null);
  const yearRaw = await panel
    .locator(".settlement-invoice-picker-year-btn")
    .first()
    .textContent()
    .catch(() => null);
  if (!monthRaw?.trim() || !yearRaw?.trim()) {
    return null;
  }
  const digits = String(yearRaw).replace(/\D/g, "");
  const y = parseInt(digits, 10);
  const m = falabellaMonthLabelToNumber(monthRaw);
  if (!Number.isFinite(y) || m === undefined) {
    return null;
  }
  return { y, m };
}

/**
 * El range picker de Falabella suele abrirse en «hoy» (p. ej. abril); hay que llevar el panel
 * izquierdo o derecho explícitamente al mes del `targetIso` antes de cliquear el día.
 */
async function ensureSettlementPickerPanelShowsYearMonth(
  page: Page,
  panel: Locator,
  targetYear: number,
  targetMonth: number,
): Promise<void> {
  const prev = panel
    .locator("button.settlement-invoice-picker-header-prev-btn")
    .filter({ visible: true })
    .first();
  const next = panel
    .locator("button.settlement-invoice-picker-header-next-btn")
    .filter({ visible: true })
    .first();

  for (let i = 0; i < 48; i += 1) {
    const cur = await readSettlementPickerPanelYearMonth(panel);
    if (!cur) {
      await page.waitForTimeout(150);
      continue;
    }
    if (cur.y === targetYear && cur.m === targetMonth) {
      return;
    }
    const curOrd = cur.y * 12 + cur.m;
    const tgtOrd = targetYear * 12 + targetMonth;
    if (curOrd > tgtOrd) {
      await prev.click({ timeout: 5_000 }).catch(() => undefined);
    } else {
      await next.click({ timeout: 5_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(180);
  }

  throw new Error(
    `Falabella documentos: no pude alinear el calendario settlement al mes ${targetYear}-${String(targetMonth).padStart(2, "0")}.`,
  );
}

async function waitForFalabellaDatePickerRoot(page: Page): Promise<{
  root: Locator;
  flavor: FalabellaDatePickerFlavor;
}> {
  const settlement = page.locator(".settlement-invoice-picker-panel-container").first();
  try {
    await settlement.waitFor({ state: "visible", timeout: 15_000 });
    return { root: settlement, flavor: "settlement" };
  } catch {
    const ant = page.locator(".ant-picker-dropdown").filter({ has: page.locator(".ant-picker-panel") }).first();
    await ant.waitFor({ state: "visible", timeout: 10_000 });
    return { root: ant, flavor: "ant" };
  }
}

async function pickFalabellaDatePickerDayWithPanelNavigation(
  page: Page,
  root: Locator,
  panel: Locator,
  targetIso: string,
  flavor: FalabellaDatePickerFlavor,
): Promise<void> {
  /** En settlement el panel derecho puede ser el mes siguiente; las fechas del mes izquierdo solo son clicables ahí. */
  const cellLocator =
    flavor === "settlement"
      ? panel.locator(
          `td.settlement-invoice-picker-cell[title="${targetIso}"]:not(.settlement-invoice-picker-cell-disabled)`,
        )
      : root.locator(`td.ant-picker-cell[title="${targetIso}"]:not(.ant-picker-cell-disabled)`);

  const probeLocator =
    flavor === "settlement"
      ? panel.locator("td.settlement-invoice-picker-cell-in-view[title]")
      : panel.locator("td.ant-picker-cell-in-view[title]");

  const prev =
    flavor === "settlement"
      ? panel
          .locator("button.settlement-invoice-picker-header-prev-btn")
          .filter({ visible: true })
          .first()
      : panel
          .locator(".ant-picker-header-prev-btn")
          .or(panel.locator("button").filter({ has: page.locator(".ant-picker-prev-icon") }))
          .first();

  const next =
    flavor === "settlement"
      ? panel
          .locator("button.settlement-invoice-picker-header-next-btn")
          .filter({ visible: true })
          .first()
      : panel
          .locator(".ant-picker-header-next-btn")
          .or(panel.locator("button").filter({ has: page.locator(".ant-picker-next-icon") }))
          .first();

  const { y: targetYear, m: targetMonth } = parseFalabellaLocalIsoDate(targetIso);

  async function tryClickTargetCell(): Promise<boolean> {
    const handle = cellLocator.first();
    if ((await handle.count().catch(() => 0)) === 0) {
      return false;
    }
    if (!(await handle.isVisible().catch(() => false))) {
      return false;
    }
    await handle.scrollIntoViewIfNeeded().catch(() => undefined);
    await handle.click({ timeout: 5_000 });
    return true;
  }

  if (flavor === "settlement") {
    await ensureSettlementPickerPanelShowsYearMonth(page, panel, targetYear, targetMonth);
    for (let attempt = 0; attempt < 28; attempt += 1) {
      if (await tryClickTargetCell()) {
        return;
      }
      await ensureSettlementPickerPanelShowsYearMonth(page, panel, targetYear, targetMonth);
      await page.waitForTimeout(120);
    }
    throw new Error(`Falabella documentos: no pude seleccionar el día ${targetIso} (settlement picker).`);
  }

  for (let attempt = 0; attempt < 48; attempt += 1) {
    if (await tryClickTargetCell()) {
      return;
    }

    const probe = probeLocator.nth(8);
    const probeTitle = await probe.getAttribute("title").catch(() => null);
    if (!probeTitle) {
      await prev.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(150);
      continue;
    }

    if (probeTitle.localeCompare(targetIso) < 0) {
      await next.click({ timeout: 5_000 }).catch(() => undefined);
    } else {
      await prev.click({ timeout: 5_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(150);
  }

  throw new Error(`Falabella documentos: no pude seleccionar el día ${targetIso} (picker ${flavor}).`);
}

async function closeFalabellaDatePicker(
  page: Page,
  root: Locator,
  flavor: FalabellaDatePickerFlavor,
): Promise<void> {
  if (flavor === "settlement") {
    const close = root.locator(".settlement-invoice-picker-footer").getByRole("button", { name: /^Cerrar$/ });
    if (await close.isVisible().catch(() => false)) {
      await close.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(200);
      if (!(await root.isVisible().catch(() => false))) {
        return;
      }
    }
  } else {
    const ok = page.locator(".ant-picker-dropdown .ant-picker-ok button").first();
    if (await ok.isVisible().catch(() => false)) {
      await ok.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(200);
      return;
    }
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(200);
}

async function applyFalabellaDocumentsDateFilterRange(
  page: Page,
  onStep: StepReporter,
  startIso: string,
  endIso: string,
): Promise<void> {
  await dismissFalabellaSellerBlockingSurveys(page, onStep);

  await onStep(`Falabella documentos: filtro de fechas ${startIso} → ${endIso} (date-filter-input-id).`);

  const input = page.getByTestId("date-filter-input-id");
  await input.waitFor({ state: "visible", timeout: 20_000 });
  await input.scrollIntoViewIfNeeded().catch(() => undefined);
  await input.click({ timeout: 10_000 });

  const { root, flavor } = await waitForFalabellaDatePickerRoot(page);

  const panels =
    flavor === "settlement" ? root.locator(".settlement-invoice-picker-panel") : root.locator(".ant-picker-panel");
  const panelCount = await panels.count().catch(() => 0);
  const startPanel = panelCount > 0 ? panels.first() : root;

  await pickFalabellaDatePickerDayWithPanelNavigation(page, root, startPanel, startIso, flavor);

  await page.waitForTimeout(400);

  const pickerStillOpen = await root.isVisible().catch(() => false);
  if (pickerStillOpen) {
    await onStep(
      endIso === startIso
        ? `Falabella documentos: confirmo fin de rango el mismo día ${endIso}.`
        : `Falabella documentos: elijo fin de rango ${endIso}.`,
    );
    const endPanel =
      panelCount > 1 && !falabellaIsoSameCalendarMonth(startIso, endIso) ? panels.nth(1) : startPanel;
    await pickFalabellaDatePickerDayWithPanelNavigation(page, root, endPanel, endIso, flavor);
  }

  await closeFalabellaDatePicker(page, root, flavor);
  await onStep("Falabella documentos: filtro aplicado; esperando actualización de la bandeja.");
}

async function collectFalabellaPendingRowsAcrossPagesWithAccumulation(
  page: Page,
  onStep: StepReporter,
  collected: Map<string, FalabellaRowCandidate>,
): Promise<number> {
  await ensureFalabellaDocumentsStartFromFirstPage(page, onStep);
  const visitedPageStates = new Set<string>();
  let visitedPages = 0;

  while (true) {
    await waitForFalabellaDocumentsRows(page, 30_000, onStep);
    await onStep(
      "Falabella documentos: leyendo controles de paginación (.settlement-invoice-pagination / ul.ant-pagination).",
    );
    const pagination = await readFalabellaPaginationState(page);
    const pageState = await buildFalabellaPageStateKey(page, pagination.currentPage);

    if (visitedPageStates.has(pageState)) {
      break;
    }

    visitedPageStates.add(pageState);
    visitedPages += 1;

    await onStep(
      pagination.totalPages > 1
        ? `Documentos tributarios: revisando página ${pagination.currentPage} de ${pagination.totalPages}.`
        : pagination.hasNextPage
          ? `Documentos tributarios: revisando página ${pagination.currentPage} (detectando total de páginas).`
          : "Documentos tributarios: revisando la única página disponible.",
    );

    const pageCandidates = await collectFalabellaPendingRowsFromCurrentPage(page, onStep);
    for (const candidate of pageCandidates) {
      if (!collected.has(candidate.externalId)) {
        collected.set(candidate.externalId, candidate);
      }
    }

    if (!pagination.hasNextPage) {
      break;
    }

    await onStep(
      pagination.nextPage
        ? `Documentos tributarios: avanzando a la página ${pagination.nextPage}.`
        : "Documentos tributarios: avanzando a la siguiente página.",
    );
    await goToNextFalabellaDocumentsPage(page, pagination.currentPage, pageState, onStep);
  }

  return visitedPages;
}

async function collectFalabellaPendingRowsAcrossPages(
  page: Page,
  onStep: StepReporter,
  searchFromIso?: string,
  searchToIso?: string,
): Promise<FalabellaRowCandidate[]> {
  let ready = await waitForFalabellaDocumentsReadyState(page, onStep);
  if (ready === "timeout") {
    throw new Error(
      "Falabella documentos: la vista no quedó lista a tiempo (tabla o vacío reconocible).",
    );
  }

  const todayIso = getFalabellaTodayLocalIso();
  const effectiveToIso = searchToIso ?? todayIso;
  const collected = new Map<string, FalabellaRowCandidate>();
  let totalVisitedPages = 0;
  let chunkIndex = 0;

  if (!searchFromIso) {
    await onStep(
      "Documentos tributarios: sin fecha de inicio; no abro el selector de fechas y recorro la bandeja tal como está.",
    );
    if (ready === "empty") {
      await onStep("Documentos tributarios: la vista actual está vacía; no hay órdenes que acumular.");
      return [];
    }
    const visitedPages = await collectFalabellaPendingRowsAcrossPagesWithAccumulation(page, onStep, collected);
    totalVisitedPages = visitedPages;
    if (collected.size === 0) {
      await onStep(
        "Documentos tributarios: recorrido sin ajustar fechas — sin órdenes con documento pendiente en la vista actual.",
      );
      return [];
    }
    await onStep(
      `Documentos tributarios: ${collected.size} orden(es) con documento pendiente (${totalVisitedPages} página(s), filtro de fechas no modificado).`,
    );
    return Array.from(collected.values());
  }

  for (const { start, end } of iterateFalabellaDateChunksFromRangeStart(searchFromIso, effectiveToIso)) {
    chunkIndex += 1;
    await onStep(
      `Documentos tributarios: bloque ${chunkIndex} (${start}–${end}): ${FALABELLA_DOCUMENTS_DATE_CHUNK_DAYS} días corridos; en el filtro lo parto por mes calendario.`,
    );

    let visitedInChunk = 0;
    let partIndex = 0;
    for (const { start: segStart, end: segEnd } of subdivideFalabellaIsoRangeByCalendarMonth(start, end)) {
      partIndex += 1;
      await applyFalabellaDocumentsDateFilterRange(page, onStep, segStart, segEnd);

      ready = await waitForFalabellaDocumentsReadyState(page, onStep);
      if (ready === "timeout") {
        throw new Error(
          `Falabella documentos: tras el filtro ${segStart}–${segEnd} (bloque ${chunkIndex} · parte ${partIndex}) la vista no volvió a mostrar tabla ni estado vacío a tiempo.`,
        );
      }

      if (ready === "empty") {
        await onStep(
          `Documentos tributarios: bloque ${chunkIndex} parte ${partIndex} (${segStart}–${segEnd}): vacía; siguiente parte.`,
        );
        continue;
      }

      await onStep(
        `Documentos tributarios: bloque ${chunkIndex} parte ${partIndex} (${segStart}–${segEnd}): pagino y acumulo (únicas: ${collected.size}).`,
      );
      visitedInChunk += await collectFalabellaPendingRowsAcrossPagesWithAccumulation(page, onStep, collected);
    }

    totalVisitedPages += visitedInChunk;
    await onStep(
      `Documentos tributarios: bloque ${chunkIndex} cerrado — ${visitedInChunk} página(s); acumulado ${collected.size} orden(es).`,
    );
  }

  if (collected.size === 0) {
    await onStep(
      `Documentos tributarios: barridos de ~30 días desde ${searchFromIso} hasta ${effectiveToIso} — sin órdenes con documento pendiente.`,
    );
    return [];
  }

  await onStep(
    `Documentos tributarios: ${collected.size} orden(es) con documento pendiente (${totalVisitedPages} páginas entre todos los tramos).`,
  );
  return Array.from(collected.values());
}

async function findFalabellaPendingRowByOrderIdAcrossPages(
  page: Page,
  orderId: string,
  onStep: StepReporter,
  searchFromIso?: string,
  searchToIso?: string,
): Promise<FalabellaRowCandidate | undefined> {
  let ready = await waitForFalabellaDocumentsReadyState(page, onStep);
  if (ready === "timeout") {
    throw new Error(
      "Falabella documentos: la vista no quedó lista a tiempo (tabla o vacío reconocible).",
    );
  }

  const todayIso = getFalabellaTodayLocalIso();
  const effectiveToIso = searchToIso ?? todayIso;
  let chunkIndex = 0;

  if (!searchFromIso) {
    await onStep(
      `Documentos tributarios: sin fecha de inicio; busco la orden ${orderId} sin abrir el selector de fechas.`,
    );
    if (ready === "empty") {
      await onStep(
        `Documentos tributarios: la vista actual está vacía; la orden ${orderId} no aparece sin cambiar fechas.`,
      );
      return undefined;
    }
    await ensureFalabellaDocumentsStartFromFirstPage(page, onStep);
    const visitedPageStates = new Set<string>();

    while (true) {
      await waitForFalabellaDocumentsRows(page, 30_000, onStep);
      const pagination = await readFalabellaPaginationState(page);
      const pageState = await buildFalabellaPageStateKey(page, pagination.currentPage);

      if (visitedPageStates.has(pageState)) {
        break;
      }

      visitedPageStates.add(pageState);
      await onStep(
        pagination.totalPages > 1
          ? `Documentos tributarios: busco ${orderId} en pág. ${pagination.currentPage} de ${pagination.totalPages} (filtro actual).`
          : `Documentos tributarios: busco ${orderId} en la página disponible (filtro actual).`,
      );

      const row = await findFalabellaOrderRowByOrderId(page, orderId);
      if (row) {
        return extractEnabledFalabellaRow(row, orderId);
      }

      if (!pagination.hasNextPage) {
        break;
      }

      await goToNextFalabellaDocumentsPage(page, pagination.currentPage, pageState, onStep);
    }

    await onStep(
      `Documentos tributarios: la orden ${orderId} no apareció al paginar la vista actual (sin ajustar fechas).`,
    );
    return undefined;
  }

  for (const { start, end } of iterateFalabellaDateChunksFromRangeStart(searchFromIso, effectiveToIso)) {
    chunkIndex += 1;
    let partIndex = 0;
    for (const { start: segStart, end: segEnd } of subdivideFalabellaIsoRangeByCalendarMonth(start, end)) {
      partIndex += 1;
      await applyFalabellaDocumentsDateFilterRange(page, onStep, segStart, segEnd);

      ready = await waitForFalabellaDocumentsReadyState(page, onStep);
      if (ready === "timeout") {
        throw new Error(
          `Falabella documentos: tras el filtro ${segStart}–${segEnd} (bloque ${chunkIndex} · parte ${partIndex}) la vista no volvió a mostrar tabla ni estado vacío a tiempo.`,
        );
      }

      if (ready === "empty") {
        await onStep(
          `Documentos tributarios: bloque ${chunkIndex} parte ${partIndex} (${segStart}–${segEnd}): vacío; sigo buscando ${orderId}.`,
        );
        continue;
      }

      await ensureFalabellaDocumentsStartFromFirstPage(page, onStep);
      const visitedPageStates = new Set<string>();

      while (true) {
        await waitForFalabellaDocumentsRows(page, 30_000, onStep);
        const pagination = await readFalabellaPaginationState(page);
        const pageState = await buildFalabellaPageStateKey(page, pagination.currentPage);

        if (visitedPageStates.has(pageState)) {
          break;
        }

        visitedPageStates.add(pageState);
        await onStep(
          pagination.totalPages > 1
            ? `Documentos tributarios: bloque ${chunkIndex} parte ${partIndex} (${segStart}–${segEnd}) — busco ${orderId} en pág. ${pagination.currentPage} de ${pagination.totalPages}.`
            : `Documentos tributarios: bloque ${chunkIndex} parte ${partIndex} (${segStart}–${segEnd}) — busco ${orderId} en la página disponible.`,
        );

        const row = await findFalabellaOrderRowByOrderId(page, orderId);
        if (row) {
          return extractEnabledFalabellaRow(row, orderId);
        }

        if (!pagination.hasNextPage) {
          break;
        }

        await goToNextFalabellaDocumentsPage(page, pagination.currentPage, pageState, onStep);
      }
    }
  }

  await onStep(
    `Documentos tributarios: la orden ${orderId} no apareció en tramos de ~30 días desde ${searchFromIso} hasta hoy.`,
  );
  return undefined;
}

async function collectFalabellaPendingRowsFromCurrentPage(
  page: Page,
  onStep?: StepReporter,
): Promise<FalabellaRowCandidate[]> {
  const rows = page.locator("tbody tr[data-row-key]");
  if (!(await rows.first().isVisible().catch(() => false))) {
    return [];
  }
  const count = await rows.count();
  const candidates: FalabellaRowCandidate[] = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const externalId = await readFalabellaRowOrderId(row);
    if (!externalId) {
      await onStep?.(
        `Falabella documentos: fila ${index + 1}/${count}: no leí N° de orden en el enlace, omito.`,
      );
      continue;
    }

    const candidate = await extractEnabledFalabellaRow(row, externalId);
    if (candidate) {
      candidates.push(candidate);
      continue;
    }

    await onStep?.(
      `Falabella documentos: orden ${externalId}: ${await explainFalabellaRowNotPending(row)}`,
    );
  }

  await onStep?.(
    `Falabella documentos: en esta bandeja leí ${count} fila(s); ${candidates.length} entraron como pendiente de carga (el resto se excluyó por el motivo de cada log anterior).`,
  );

  return candidates;
}

async function findFalabellaOrderRowByOrderId(page: Page, orderId: string): Promise<Locator | undefined> {
  const row = page
    .locator("tbody tr[data-row-key]")
    .filter({
      has: page.locator("a[href*='/order/view/number/']", {
        hasText: orderId,
      }),
    })
    .first();

  const visible = await row.isVisible().catch(() => false);
  return visible ? row : undefined;
}

async function readFalabellaRowOrderId(row: Locator): Promise<string> {
  const orderId = await row
    .locator("a[href*='/order/view/number/']")
    .first()
    .textContent({ timeout: 1_000 })
    .catch(() => "");

  return ((orderId ?? "").match(/\d+/)?.[0] ?? "").trim();
}

async function waitForFalabellaPostLogin(page: Page, timeoutMs = 20_000): Promise<void> {
  const ordersMenu = page.getByRole("link", { name: /Órdenes/i }).first();
  const documentsOption = page.getByRole("link", { name: /Documentos tributarios/i }).first();

  await Promise.race([
    ordersMenu.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => undefined),
    documentsOption.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => undefined),
  ]);
}

async function dismissFalabellaMedalliaSurveyWrapper(page: Page, onStep?: StepReporter): Promise<void> {
  const wrap = page.locator("#survey-wrapper").first();
  if (!(await wrap.isVisible().catch(() => false))) {
    return;
  }

  const looksLikeFalabella =
    (await wrap.locator("form.mediumSurvey").count().catch(() => 0)) > 0 ||
    (await wrap.getByText(/falabella/i).count().catch(() => 0)) > 0;
  if (!looksLikeFalabella) {
    return;
  }

  await onStep?.("Falabella: encuesta NPS (Medallia, #survey-wrapper) visible; cierro con Cerrar o X.");

  const cerrar = wrap.locator('[data-aut="button-close"], button.surveyBtn_close').first();
  if (await cerrar.isVisible().catch(() => false)) {
    await cerrar.click({ noWaitAfter: true }).catch(() => undefined);
    await page.waitForTimeout(200);
    await onStep?.("Falabella: encuesta NPS cerrada (Cerrar).");
    return;
  }

  const closeX = wrap
    .locator(
      '[data-aut="button-x-close"], button.surveyX, button[aria-label="Close Survey"], button[aria-label="Cerrar"]',
    )
    .first();
  if (await closeX.isVisible().catch(() => false)) {
    await closeX.click({ noWaitAfter: true }).catch(() => undefined);
    await page.waitForTimeout(200);
    await onStep?.("Falabella: encuesta NPS cerrada (X).");
  }
}

async function dismissFalabellaSellerBlockingSurveys(page: Page, onStep?: StepReporter): Promise<void> {
  await dismissFalabellaDocumentUploadFeedbackModal(page, onStep);
  await dismissFalabellaMedalliaSurveyWrapper(page, onStep);
}

async function dismissFalabellaDocumentUploadFeedbackModal(page: Page, onStep?: StepReporter): Promise<void> {
  const textRe = new RegExp(
    `${escapeRegExp(FALABELLA_DOCUMENT_UPLOAD_FEEDBACK_TITLE)}|${escapeRegExp(FALABELLA_DOCUMENT_UPLOAD_FEEDBACK_MARKER)}`,
    "i",
  );

  const settlementOuter = page.locator(".settlement-invoice-modal-wrap").filter({ hasText: textRe }).first();
  const settlementModal = page.locator(".settlement-invoice-modal").filter({ hasText: textRe }).first();
  const feedbackWrap = page.locator(".ant-modal-wrap").filter({ hasText: textRe }).first();

  const outerVisible = await settlementOuter.isVisible().catch(() => false);
  const modalVisible = await settlementModal.isVisible().catch(() => false);
  const settlementVisible = outerVisible || modalVisible;
  const settlementScope = outerVisible ? settlementOuter : settlementModal;
  const wrapVisible = await feedbackWrap.isVisible().catch(() => false);

  if (!settlementVisible && !wrapVisible) {
    return;
  }

  const scope = settlementVisible ? settlementScope : feedbackWrap;

  await onStep?.(
    "Falabella: encontré el modal de feedback (título de experiencia de carga de documentos tributarios).",
  );

  const cancelOutlined = scope.locator(".settlement-invoice-modal-footer .settlement-invoice-btn-default").first();
  if (await cancelOutlined.isVisible().catch(() => false)) {
    await cancelOutlined.click({ noWaitAfter: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    await onStep?.("Falabella: modal de feedback de documentos tributarios cerrado (Cancelar).");
    return;
  }

  const cancel = scope.getByRole("button", { name: /^cancelar$/i }).first();
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click({ noWaitAfter: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    await onStep?.("Falabella: modal de feedback de documentos tributarios cerrado (Cancelar).");
    return;
  }

  const closeBtn = settlementVisible
    ? scope.locator(".settlement-invoice-modal-close, button[aria-label='Close']").first()
    : scope.locator(".ant-modal-close, .ant-modal-close-x").first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click({ noWaitAfter: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    await onStep?.("Falabella: modal de feedback de documentos tributarios cerrado (icono X).");
    return;
  }

  await onStep?.(
    "Falabella: el modal de feedback sigue visible; no encontré Cancelar ni la X para cerrarlo desde Playwright.",
  );
}

async function waitForFalabellaDocumentsRows(
  page: Page,
  timeoutMs = 30_000,
  onStep?: StepReporter,
): Promise<boolean> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  const rowLocator = page.locator("tbody tr[data-row-key]").first();
  const logProgress = Boolean(onStep) && timeoutMs >= 2_000;

  if (logProgress) {
    await onStep?.(
      `Falabella documentos: buscando filas en la tabla (selector tbody tr[data-row-key]); espera hasta ${Math.round(timeoutMs / 1000)}s.`,
    );
  }

  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let nextLogAt = started + 3_000;

  while (Date.now() < deadline) {
    if (await rowLocator.isVisible().catch(() => false)) {
      if (logProgress) {
        await onStep?.("Falabella documentos: filas de la tabla visibles.");
      }
      return true;
    }

    if (logProgress && Date.now() >= nextLogAt) {
      const elapsedSec = Math.round((Date.now() - started) / 1000);
      await onStep?.(
        `Falabella documentos: sigo buscando filas en la tabla… ${elapsedSec}s / ~${Math.round(timeoutMs / 1000)}s.`,
      );
      nextLogAt = Date.now() + 3_000;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await page.waitForTimeout(Math.min(250, remaining));
  }

  if (logProgress) {
    await onStep?.("Falabella documentos: no aparecieron filas en la tabla dentro del tiempo indicado.");
  }
  return false;
}

type FalabellaDocumentsReadyState = "rows" | "empty" | "timeout";

/** Escribe en log cuántas páginas hay (Ant Pagination) si la barra ya es visible. */
async function logFalabellaDocumentsPaginationInfo(
  page: Page,
  onStep: StepReporter,
  context: string,
): Promise<void> {
  const root = await findFalabellaDocumentsPaginationRoot(page);
  if (!root) {
    await onStep(
      `Falabella documentos (${context}): aún no veo la barra de paginación (.settlement-invoice-pagination o ul.ant-pagination); no puedo contar páginas.`,
    );
    return;
  }

  const p = await readFalabellaPaginationState(page);
  await onStep(
    `Falabella documentos (${context}): ${p.totalPages} página(s) en total; página actual ${p.currentPage}.${p.hasNextPage ? ` Hay siguiente (pág. ${p.nextPage ?? p.currentPage + 1}).` : " Siguiente deshabilitado o única página."}`,
  );
}

async function waitForFalabellaDocumentsReadyState(
  page: Page,
  onStep?: StepReporter,
  timeoutMs = 30_000,
): Promise<FalabellaDocumentsReadyState> {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let nextProgressLogAt = started + 3_000;

  await onStep?.(
    `Falabella documentos: vigilando vista de documentos (filas tbody tr[data-row-key] o placeholders ant-empty/ant-table-placeholder; hasta ${Math.round(timeoutMs / 1000)}s).`,
  );

  if (onStep) {
    await logFalabellaDocumentsPaginationInfo(page, onStep, "tras comenzar la espera");
  }

  while (Date.now() < deadline) {
    if (await waitForFalabellaDocumentsRows(page, 750)) {
      if (onStep) {
        await logFalabellaDocumentsPaginationInfo(page, onStep, "tabla con filas visibles");
      }
      await onStep?.("Falabella documentos: detecté filas en la tabla; la bandeja tiene datos.");
      return "rows";
    }

    if (await hasFalabellaDocumentsEmptyState(page)) {
      if (onStep) {
        await logFalabellaDocumentsPaginationInfo(page, onStep, "estado vacío detectado");
      }
      await onStep?.(
        "Falabella documentos: detecté estado de lista vacía (placeholder / ant-empty con texto esperado).",
      );
      return "empty";
    }

    if (onStep && Date.now() >= nextProgressLogAt) {
      const elapsedSec = Math.round((Date.now() - started) / 1000);
      await onStep(
        `Falabella documentos: aún sin filas ni vacío reconocido; reintento lectura de DOM (${elapsedSec}s / ~${Math.round(timeoutMs / 1000)}s).`,
      );
      await logFalabellaDocumentsPaginationInfo(page, onStep, "seguimiento");
      nextProgressLogAt = Date.now() + 3_000;
    }

    await page.waitForTimeout(350);
  }

  await onStep?.(
    `Falabella documentos: tiempo agotado (${Math.round(timeoutMs / 1000)}s) sin filas ni estado vacío claro.`,
  );
  return "timeout";
}

async function hasFalabellaDocumentsEmptyState(page: Page): Promise<boolean> {
  const candidates = [
    page.locator("tr.ant-table-placeholder").first(),
    page.locator(".ant-table-placeholder").first(),
    page.locator(".ant-empty").first(),
    page.locator(".ant-empty-description").first(),
    page.locator(".settlement-invoice-app .ant-table-tbody tr td[colspan]").first(),
    page.locator(".settlement-invoice-app .empty-state, .settlement-invoice-app .no-data").first(),
  ];

  for (const candidate of candidates) {
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }

    const text = ((await candidate.textContent().catch(() => "")) ?? "")
      .replace(/\s+/g, " ")
      .trim();

    if (falabellaDocumentsTextLooksEmpty(text)) {
      return true;
    }
  }

  return false;
}

async function ensureFalabellaDocumentsStartFromFirstPage(
  page: Page,
  onStep?: StepReporter,
): Promise<void> {
  await onStep?.(
    "Falabella documentos: asegurando que la paginación empiece en página 1; primero espero filas visibles.",
  );
  await waitForFalabellaDocumentsRows(page, 30_000, onStep);
  await onStep?.(
    "Falabella documentos: buscando barra de paginación (ul.ant-pagination / .settlement-invoice-pagination). Si no hay, asumo una sola página (sin escanear todo el sitio).",
  );
  let pagination = await readFalabellaPaginationState(page);

  await onStep?.(
    `Falabella documentos: paginación interpretada — página ${pagination.currentPage} de ${pagination.totalPages}${pagination.hasNextPage ? `; hay página siguiente (${pagination.nextPage ?? "?"}).` : "; sin página siguiente."}`,
  );

  if (pagination.currentPage <= 1) {
    await onStep?.("Falabella documentos: ya estoy en página 1; no muevo paginación.");
    return;
  }

  await onStep?.(
    `Documentos tributarios: empezaré desde la página 1 para recopilar toda la información (ahora estoy en la ${pagination.currentPage}).`,
  );

  await onStep?.("Falabella documentos: buscando control numérico de página 1 en la paginación.");
  const firstPageControl = await findFalabellaPaginationPageControl(page, 1);
  if (firstPageControl) {
    const previousState = await buildFalabellaPageStateKey(page, pagination.currentPage);
    await firstPageControl.scrollIntoViewIfNeeded().catch(() => undefined);
    await firstPageControl.click({ noWaitAfter: true }).catch(() => undefined);
    await waitForFalabellaDocumentsPageChange(page, pagination.currentPage, previousState, onStep);
    await onStep?.("Documentos tributarios: ya estoy en la página 1.");
    return;
  }

  while (pagination.currentPage > 1) {
    await onStep?.(
      "Falabella documentos: buscando botón «página anterior» (li.ant-pagination-prev / aria-label previous).",
    );
    const previousControl = await findFalabellaPreviousPaginationControl(page);

    if (!previousControl) {
      throw new Error(
        "Falabella abrió Documentos tributarios en una página interna y no encontré cómo volver a la página 1.",
      );
    }

    const previousState = await buildFalabellaPageStateKey(page, pagination.currentPage);
    await previousControl.scrollIntoViewIfNeeded().catch(() => undefined);
    await previousControl.click({ noWaitAfter: true }).catch(() => undefined);
    await waitForFalabellaDocumentsPageChange(page, pagination.currentPage, previousState, onStep);
    pagination = await readFalabellaPaginationState(page);
  }

  await onStep?.("Documentos tributarios: ya estoy en la página 1.");
}

async function buildFalabellaPageStateKey(page: Page, currentPage: number): Promise<string> {
  const firstRowKey = await page
    .locator("tbody tr[data-row-key]")
    .first()
    .getAttribute("data-row-key")
    .catch(() => null);

  return `${currentPage}:${firstRowKey ?? "no-row"}`;
}

async function readFalabellaPaginationState(page: Page): Promise<FalabellaPaginationState> {
  const paginationRoot = await findFalabellaDocumentsPaginationRoot(page);

  if (!paginationRoot) {
    return {
      currentPage: 1,
      totalPages: 1,
      hasNextPage: false,
      nextPage: undefined,
    };
  }

  const scope = paginationRoot;
  const pageLabels = await collectFalabellaPaginationPageNumbers(scope);
  const currentLabel = await readFalabellaCurrentPaginationLabel(scope);
  const currentPage = Number(currentLabel) || 1;
  const inferredTotalFromLabels = pageLabels.length ? Math.max(...pageLabels) : currentPage;
  const hintedTotal = await readFalabellaTotalPagesHint(scope);
  const totalPages = Math.max(inferredTotalFromLabels, hintedTotal ?? currentPage);
  const nextItem = await findFalabellaNextPaginationControl(page);
  const nextDisabled = nextItem ? await isFalabellaPaginationControlDisabled(nextItem) : true;

  return {
    currentPage,
    totalPages,
    hasNextPage: Boolean(nextItem) && !nextDisabled && currentPage < Math.max(totalPages, currentPage + 1),
    nextPage: Boolean(nextItem) && !nextDisabled ? currentPage + 1 : undefined,
  };
}

async function collectFalabellaPaginationPageNumbers(scope: Page | Locator): Promise<number[]> {
  const items = scope.locator("li.settlement-invoice-pagination-item, li.ant-pagination-item");
  const n = await items.count().catch(() => 0);
  const numbers: number[] = [];

  for (let i = 0; i < n; i += 1) {
    const raw = ((await items.nth(i).textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    const value = Number(raw.match(/\d+/)?.[0]);
    if (Number.isFinite(value) && value > 0) {
      numbers.push(value);
    }
  }

  return Array.from(new Set(numbers));
}

async function readFalabellaCurrentPaginationLabel(scope: Page | Locator): Promise<string> {
  const selectors = [
    "li.settlement-invoice-pagination-item-active",
    "li.ant-pagination-item-active",
    "[aria-current='page']",
    ".active",
    ".selected",
    "[aria-selected='true']",
  ];

  for (const selector of selectors) {
    const text = ((await scope.locator(selector).first().textContent().catch(() => "")) ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const match = text.match(/\d+/)?.[0];

    if (match) {
      return match;
    }
  }

  return "";
}

async function readFalabellaTotalPagesHint(scope: Page | Locator): Promise<number | undefined> {
  const texts = (
    await scope
      .locator(
        ".ant-pagination-options, .ant-pagination-total-text, .ant-pagination-jump, .settlement-invoice-pagination-total-text, li.settlement-invoice-pagination-item, li.ant-pagination-item",
      )
      .allTextContents()
      .catch(() => [])
  )
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 40);

  for (const text of texts) {
    const slash = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    if (slash) {
      const total = Number(slash[2]);
      if (Number.isFinite(total) && total > 0) {
        return total;
      }
    }

    if (/\bart[ií]culos\b/i.test(text) || /\bitems\b/i.test(text)) {
      continue;
    }

    const spanish = text.match(/\b(?:de|total)\s*(\d+)\b/i);
    if (spanish) {
      const total = Number(spanish[1]);
      if (Number.isFinite(total) && total > 0) {
        return total;
      }
    }
  }

  return undefined;
}

async function isFalabellaPaginationControlDisabled(control: Locator): Promise<boolean> {
  const fromDom = await control
    .evaluate((element: HTMLElement) => {
      const li = element.closest("li");
      if (li?.classList.contains("settlement-invoice-pagination-disabled")) {
        return true;
      }
      if (li?.getAttribute("aria-disabled") === "true") {
        return true;
      }
      if (element.hasAttribute("disabled")) {
        return true;
      }
      if (
        element.classList.contains("disabled")
        || element.classList.contains("ant-pagination-disabled")
      ) {
        return true;
      }
      return false;
    })
    .catch(() => false);

  if (fromDom) {
    return true;
  }

  if (await control.isDisabled().catch(() => false)) {
    return true;
  }

  if ((await control.getAttribute("disabled").catch(() => null)) !== null) {
    return true;
  }

  return (await control.getAttribute("aria-disabled").catch(() => null)) === "true";
}

async function goToNextFalabellaDocumentsPage(
  page: Page,
  currentPage: number,
  previousState: string,
  onStep?: StepReporter,
): Promise<void> {
  await onStep?.(
    "Falabella documentos: buscando control «siguiente página» (li.ant-pagination-next / aria-label next).",
  );
  const nextControl = await findFalabellaNextPaginationControl(page);

  if (!nextControl) {
    throw new Error("No se encontró el botón para avanzar a la siguiente página de Documentos tributarios.");
  }

  await nextControl.scrollIntoViewIfNeeded().catch(() => undefined);
  await nextControl.click({ noWaitAfter: true }).catch(() => undefined);
  await waitForFalabellaDocumentsPageChange(page, currentPage, previousState, onStep);
}

async function findFalabellaPaginationPageControl(
  page: Page,
  targetPage: number,
): Promise<Locator | undefined> {
  const paginationRoot = await findFalabellaDocumentsPaginationRoot(page);
  const scope = paginationRoot ?? page;
  const candidates = [
    scope
      .locator("li.settlement-invoice-pagination-item")
      .filter({ hasText: new RegExp(`^\\s*${targetPage}\\s*$`) })
      .first(),
    scope
      .locator("li.ant-pagination-item")
      .filter({ hasText: new RegExp(`^\\s*${targetPage}\\s*$`) })
      .first(),
    scope.getByRole("button", { name: new RegExp(`^\\s*${targetPage}\\s*$`) }).first(),
    scope.getByText(new RegExp(`^\\s*${targetPage}\\s*$`)).first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return undefined;
}

async function findFalabellaNextPaginationControl(page: Page): Promise<Locator | undefined> {
  const paginationRoot = await findFalabellaDocumentsPaginationRoot(page);
  const scope = paginationRoot ?? page;
  const candidates = [
    scope.locator("li.settlement-invoice-pagination-next button").first(),
    scope.locator("li.settlement-invoice-pagination-next").first(),
    scope.locator("li.ant-pagination-next button").first(),
    scope.locator("li.ant-pagination-next").first(),
    scope.locator("[aria-label*='next' i]").first(),
    scope.locator("[title*='next' i]").first(),
    scope.locator("[title*='siguiente' i]").first(),
    scope.getByRole("button", { name: /^\s*>\s*$/ }).first(),
    scope.getByText(/^\s*>\s*$/).first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      const disabled = await isFalabellaPaginationControlDisabled(candidate);
      if (!disabled) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function findFalabellaDocumentsPaginationRoot(page: Page): Promise<Locator | undefined> {
  const candidateContainers = page.locator(".settlement-invoice-pagination, ul.ant-pagination");
  let best: { locator: Locator; score: number } | undefined;
  const count = await candidateContainers.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const candidate = candidateContainers.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }

    const itemCount = await candidate
      .locator("li.settlement-invoice-pagination-item, li.ant-pagination-item")
      .count()
      .catch(() => 0);
    const hasCurrent =
      (await candidate
        .locator(
          "li.settlement-invoice-pagination-item-active, li.ant-pagination-item-active, [aria-current='page']",
        )
        .count()
        .catch(() => 0)) > 0;
    const hasNext =
      (await candidate
        .locator(
          "li.settlement-invoice-pagination-next, li.ant-pagination-next, [aria-label*='next' i], [title*='next' i], [title*='siguiente' i]",
        )
        .count()
        .catch(() => 0)) > 0;
    const score = (itemCount * 3) + (hasCurrent ? 4 : 0) + (hasNext ? 2 : 0);

    if (!best || score > best.score) {
      best = { locator: candidate, score };
    }
  }

  if (best) {
    return best.locator;
  }

  const paginations = page.locator("ul.ant-pagination");
  const paginationCount = await paginations.count().catch(() => 0);

  for (let index = paginationCount - 1; index >= 0; index -= 1) {
    const candidate = paginations.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }

    const itemCount = await candidate
      .locator(
        "li.settlement-invoice-pagination-item, li.settlement-invoice-pagination-next, li.ant-pagination-item, li.ant-pagination-next",
      )
      .count()
      .catch(() => 0);
    if (itemCount > 0) {
      return candidate;
    }
  }

  return undefined;
}

async function findFalabellaPreviousPaginationControl(page: Page): Promise<Locator | undefined> {
  const paginationRoot = await findFalabellaDocumentsPaginationRoot(page);
  const scope = paginationRoot ?? page;
  const candidates = [
    scope.locator("li.settlement-invoice-pagination-prev button").first(),
    scope.locator("li.settlement-invoice-pagination-prev").first(),
    scope.locator("li.ant-pagination-prev button").first(),
    scope.locator("li.ant-pagination-prev").first(),
    scope.locator("[aria-label*='prev' i], [aria-label*='previous' i]").first(),
    scope.locator("[title*='prev' i], [title*='previous' i]").first(),
    scope.locator("[title*='anterior' i]").first(),
    scope.getByRole("button", { name: /^\s*<\s*$/ }).first(),
    scope.getByText(/^\s*<\s*$/).first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      const disabled = await isFalabellaPaginationControlDisabled(candidate);
      if (!disabled) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function waitForFalabellaDocumentsPageChange(
  page: Page,
  previousPage: number,
  previousState: string,
  onStep?: StepReporter,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  const started = Date.now();
  let nextLogAt = started + 3_000;

  await onStep?.(
    `Falabella documentos: esperando cambio de página o de filas (${previousPage} → siguiente; hasta 30s).`,
  );

  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const pagination = await readFalabellaPaginationState(page);
    const currentState = await buildFalabellaPageStateKey(page, pagination.currentPage);

    if (pagination.currentPage !== previousPage || currentState !== previousState) {
      await waitForFalabellaDocumentsRows(page, 30_000, onStep);
      await onStep?.(
        `Falabella documentos: paginación actualizada (página ${pagination.currentPage}); filas listas.`,
      );
      return;
    }

    if (onStep && Date.now() >= nextLogAt) {
      const elapsedSec = Math.round((Date.now() - started) / 1000);
      await onStep(
        `Falabella documentos: aún en página ${previousPage}, esperando re-render tras el click… ${elapsedSec}s.`,
      );
      nextLogAt = Date.now() + 3_000;
    }
  }

  throw new Error("Falabella no avanzó a la siguiente página de Documentos tributarios.");
}

/** Busca en celdas de la fila el texto de progreso «subidos de total» (p. ej. 0 de 1); la columna varía. */
async function readFalabellaRowDocumentProgressRaw(row: Locator): Promise<string> {
  const cells = row.locator(":scope > td");
  const n = await cells.count().catch(() => 0);

  for (let i = 0; i < n; i += 1) {
    const text = ((await cells.nth(i).textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    if (/\d+\s+de\s+\d+/i.test(text)) {
      return text;
    }
  }

  return "";
}

/** Fecha visible en la fila (celda que parece fecha); evita depender de un índice fijo. */
async function readFalabellaRowIssuedAtRaw(row: Locator): Promise<string> {
  const cells = row.locator(":scope > td");
  const n = await cells.count().catch(() => 0);

  for (let i = 0; i < n; i += 1) {
    const text = ((await cells.nth(i).textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(text) || /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(text)) {
      return text;
    }
  }

  return ((await row.locator(":scope > td").nth(1).textContent().catch(() => "")) ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

async function explainFalabellaRowNotPending(row: Locator): Promise<string> {
  const orderLink = row.locator("a[href*='/order/view/number/']").first();
  const detailUrl = await orderLink.getAttribute("href", { timeout: 500 }).catch(() => null);

  if (!detailUrl) {
    return "sin enlace /order/view/number/ en la fila.";
  }

  const button = row.locator("button.uploadbtn").first();
  const disabled =
    (await button.isDisabled().catch(() => false)) ||
    (await button.getAttribute("disabled").catch(() => null)) !== null;

  if (disabled) {
    return "botón de carga (uploadbtn) deshabilitado.";
  }

  const documentProgress = await readFalabellaRowDocumentProgressRaw(row);
  const counts = parseFalabellaDocumentProgress(documentProgress);

  if (!counts) {
    const hint = documentProgress
      ? `texto de celda con «de»: «${documentProgress.slice(0, 100)}${documentProgress.length > 100 ? "…" : ""}»`
      : "ninguna celda de la fila coincidió con patrón «número de número» (documentos asociados).";
    return `no pude interpretar progreso de documentos; ${hint}`;
  }

  if (counts.uploaded >= counts.total) {
    return `no está pendiente según progreso (${counts.raw}, ya cargados todos).`;
  }

  return "excluida por validación interna inesperada.";
}

async function extractEnabledFalabellaRow(
  row: Locator,
  expectedOrderId?: string,
): Promise<FalabellaRowCandidate | undefined> {
  const orderLink = row.locator("a[href*='/order/view/number/']").first();
  const detailUrl = await orderLink.getAttribute("href", { timeout: 1_000 }).catch(() => null);

  if (!detailUrl) {
    return undefined;
  }

  const button = row.locator("button.uploadbtn").first();
  const disabled =
    (await button.isDisabled().catch(() => false)) ||
    (await button.getAttribute("disabled").catch(() => null)) !== null;

  const documentProgress = await readFalabellaRowDocumentProgressRaw(row);
  const counts = parseFalabellaDocumentProgress(documentProgress);

  if (disabled || !counts || counts.uploaded >= counts.total) {
    return undefined;
  }

  const externalId = (((await orderLink.textContent().catch(() => "")) ?? "").match(/\d+/)?.[0] ?? "").trim();
  const issuedAt = await readFalabellaRowIssuedAtRaw(row);

  if (!externalId || (expectedOrderId && externalId !== expectedOrderId)) {
    return undefined;
  }

  return {
    externalId,
    detailUrl,
    issuedAt,
    documentProgress: counts.raw,
    uploadedDocuments: counts.uploaded,
    totalDocuments: counts.total,
    requestedDocumentType: undefined,
    itemDocumentTypes: [],
  };
}

async function waitForFalabellaOrderDetailReady(
  detailPage: Page,
  detailUrl: string,
  config: AppConfig,
  orderId: string,
  onStep?: StepReporter,
): Promise<Record<string, string>> {
  await detailPage.goto(detailUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  try {
    await detailPage.getByText(/Informaci[oó]n del cliente/i).first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await detailPage.locator(".card-details .row.my-1").first().waitFor({
      state: "visible",
      timeout: 15_000,
    });
  } catch (error) {
    throw await buildFalabellaOrderDetailError(
      detailPage,
      config,
      orderId,
      "la apertura inicial del detalle",
      error,
      onStep,
    );
  }

  await detailPage.waitForTimeout(2_000);
  return readFalabellaDetailMap(detailPage);
}

async function buildFalabellaOrderDetailError(
  detailPage: Page,
  config: AppConfig,
  orderId: string,
  phase: string,
  cause: unknown,
  onStep?: StepReporter,
): Promise<Error> {
  const finalUrl = detailPage.url();
  const title = await detailPage.title().catch(() => "");
  const bodyText = ((await detailPage.locator("body").textContent().catch(() => "")) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const visibleHeadings = await detailPage
    .locator("h1, h2, h3, [role='heading']")
    .evaluateAll((elements) =>
      elements
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 6),
    )
    .catch(() => [] as string[]);
  const screenshotPath = path.join(
    config.dataPaths.screenshotsDir,
    `falabella-detail-${orderId}-${Date.now()}.png`,
  );

  await detailPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  const screenshotNote = fs.existsSync(screenshotPath) ? screenshotPath : undefined;
  const rootMessage = cause instanceof Error ? cause.message : String(cause ?? "Error desconocido.");
  const bodySnippet = bodyText ? truncateForLog(bodyText, 300) : "sin texto visible en body";
  const headingsSnippet = visibleHeadings.length ? visibleHeadings.join(" | ") : "sin headings visibles";

  await onStep?.(
    `Falabella detalle ${orderId}: no apareció «Información del cliente» durante ${phase}. URL final: ${finalUrl || "sin URL"}.`,
  );
  await onStep?.(
    `Falabella detalle ${orderId}: title=${title || "sin title"}; headings=${headingsSnippet}.`,
  );
  await onStep?.(`Falabella detalle ${orderId}: texto visible resumido: ${bodySnippet}.`);
  if (screenshotNote) {
    await onStep?.(`Falabella detalle ${orderId}: screenshot guardado en ${screenshotNote}.`);
  }

  return new Error(
    [
      `Falabella detalle ${orderId}: no apareció «Información del cliente» durante ${phase}.`,
      `URL final: ${finalUrl || "sin URL"}`,
      `Title: ${title || "sin title"}`,
      `Headings visibles: ${headingsSnippet}`,
      `Texto visible: ${bodySnippet}`,
      screenshotNote ? `Screenshot: ${screenshotNote}` : "Screenshot: no disponible",
      `Causa original: ${rootMessage}`,
    ].join("\n"),
  );
}

function falabellaDetailIndicatesFactura(detailMap: Record<string, string>): boolean {
  const raw = (detailMap["documento tributario"] ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  if (!raw) {
    return false;
  }

  return /\bfactura\b/.test(raw);
}

async function readFalabellaSaleFromDetail(
  detailPage: Page,
  row: FalabellaRowCandidate,
  config: AppConfig,
  options?: { initialDetailMap?: Record<string, string>; onStep?: StepReporter },
): Promise<Sale> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let detailMap: Record<string, string>;

    if (attempt === 0 && options?.initialDetailMap) {
      detailMap = options.initialDetailMap;
      await detailPage.waitForTimeout(500);
    } else {
      await detailPage.goto(row.detailUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      try {
        await detailPage.getByText(/Informaci[oó]n del cliente/i).first().waitFor({
          state: "visible",
          timeout: 30_000,
        });
        await detailPage.locator(".card-details .row.my-1").first().waitFor({
          state: "visible",
          timeout: 15_000,
        });
      } catch (error) {
        throw await buildFalabellaOrderDetailError(
          detailPage,
          config,
          row.externalId,
          `la recarga del detalle (intento ${attempt + 1})`,
          error,
          options?.onStep,
        );
      }

      await detailPage.waitForTimeout(attempt === 0 ? 2_000 : 4_000);
      detailMap = await readFalabellaDetailMap(detailPage);
    }
    const total = parseAmount(
      detailMap["gran total"] ?? detailMap["productos incluidos impuestos"] ?? "",
    );
    const issuedAt = normalizeFalabellaIssuedAt(detailMap.fecha ?? row.issuedAt);
    const productCount = await readFalabellaProductCount(detailPage, row.itemDocumentTypes.length);
    const productDescription = await readFalabellaPrimaryProductDescription(detailPage, row.itemDocumentTypes);
    const computedTotal = total;
    const customerName = detailMap.cliente ?? "Cliente sin nombre";
    const documentNumber = normalizeFalabellaCustomerDocumentNumber(
      detailMap["n identificacion"] ??
        detailMap["numero identificacion"] ??
        "",
    );
    const tributaryDocumentLabel = (detailMap["documento tributario"] ?? "").replace(/\s+/g, " ").trim();
    const requestedDocumentTypeFromDetail = normalizeFalabellaDocumentType(tributaryDocumentLabel);

    if (customerName !== "Cliente sin nombre" && documentNumber && productCount > 0 && computedTotal > 0) {
      const { baseAmount, taxAmount } = splitIgv(computedTotal);
      const aggregateItem = buildFalabellaBoletaAggregateItem(
        row.externalId,
        productDescription,
        productCount,
        computedTotal,
      );

      return normalizeSale({
        externalId: row.externalId,
        issuedAt,
        currency: "PEN",
        customer: {
          name: customerName,
          documentNumber,
        },
        items: [aggregateItem],
        totals: {
          subtotal: baseAmount,
          tax: taxAmount,
          total: computedTotal,
        },
        raw: {
          source: "falabella",
          detailUrl: row.detailUrl,
          dashboardUrl: config.sellerPurchasedOrdersUrl,
          documentProgress: row.documentProgress,
          requestedDocumentType: requestedDocumentTypeFromDetail ?? row.requestedDocumentType,
          productCount,
          uploadedDocuments: row.uploadedDocuments,
          totalDocuments: row.totalDocuments,
          falabellaIssuedAt: detailMap.fecha ?? row.issuedAt,
        },
      });
    }
  }

  throw new Error(`No se pudo leer el detalle completo de la orden ${row.externalId}.`);
}

async function persistFalabellaLocalStorage(page: Page): Promise<void> {
  await page.evaluate((entries) => {
    for (const [key, value] of entries) {
      window.localStorage.setItem(key, value);
    }
  }, FALABELLA_LOCAL_STORAGE_ENTRIES).catch(() => undefined);
}

async function readFalabellaDetailMap(page: Page): Promise<Record<string, string>> {
  const rows = await page.locator(".card-details .row.my-1").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const columns = Array.from(element.querySelectorAll(":scope > div"));
      if (columns.length < 2) {
        return [];
      }

      const pairs: Array<{ label: string; value: string }> = [];
      for (let index = 0; index + 1 < columns.length; index += 2) {
        pairs.push({
          label: (columns[index].textContent || "").replace(/\s+/g, " ").trim(),
          value: (columns[index + 1].textContent || "").replace(/\s+/g, " ").trim(),
        });
      }

      return pairs;
    }),
  );

  const map: Record<string, string> = {};

  for (const row of rows) {
    if (!row.label) {
      continue;
    }
    map[normalizeDetailLabel(row.label)] = row.value;
  }

  return map;
}

export function normalizeFalabellaCustomerDocumentNumber(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

async function readFalabellaProductCount(
  detailPage: Page,
  fallbackCount: number,
): Promise<number> {
  const quantityTexts = await detailPage.locator('[role="row"][id^="row-"]').evaluateAll((elements) => {
    const texts: string[] = [];

    for (const element of elements) {
      const description =
        element.querySelector("img[alt]")?.getAttribute("alt")?.trim() ||
        element.querySelector("p.fw-700")?.textContent?.replace(/\s+/g, " ").trim() ||
        "";

      if (!description) {
        continue;
      }

      const quantityText =
        element
          .querySelector('[data-column-id="3"] [data-tag="allowRowEvents"], [data-column-id="3"]')
          ?.textContent?.replace(/\s+/g, " ")
          .trim() || "";

      texts.push(quantityText);
    }

    return texts;
  });

  const fromCantidadColumn = quantityTexts.reduce(
    (sum, raw) => sum + Math.max(parseAmount(raw), 1),
    0,
  );

  if (fromCantidadColumn > 0) {
    return fromCantidadColumn;
  }

  if (fallbackCount > 0) {
    return fallbackCount;
  }

  return quantityTexts.length;
}

async function readFalabellaPrimaryProductDescription(
  detailPage: Page,
  documentEntries: Array<{ description: string; documentType?: string }>,
): Promise<string> {
  const detailDescription = await detailPage
    .locator('[role="row"][id^="row-"] img[alt], [role="row"][id^="row-"] p.fw-700')
    .first()
    .evaluate((element) => {
      if (element instanceof HTMLImageElement) {
        return element.alt.trim();
      }
      return (element.textContent || "").replace(/\s+/g, " ").trim();
    })
    .catch(() => "");

  if (detailDescription) {
    return detailDescription;
  }

  const firstDocumentDescription = documentEntries.find((entry) => entry.description)?.description?.trim();
  if (firstDocumentDescription) {
    return firstDocumentDescription;
  }

  return `PRODUCTO ORDEN ${Date.now()}`;
}

function buildFalabellaBoletaAggregateItem(
  externalId: string,
  description: string,
  productCount: number,
  total: number,
): SaleItem {
  const quantity = Math.max(productCount, 1);
  const lineTotal = roundCurrency(total);

  return {
    description: description || `PRODUCTO ORDEN ${externalId}`,
    quantity,
    unitPrice: quantity > 0 ? roundCurrency(lineTotal / quantity) : lineTotal,
    total: lineTotal,
    documentType: "Boleta",
  };
}

async function readFalabellaItems(
  page: Page,
  documentEntries: Array<{ description: string; documentType?: string }> = [],
): Promise<SaleItem[]> {
  const rows = await page.locator('[role="row"][id^="row-"]').evaluateAll((elements) =>
    elements
      .map((element) => {
        const description =
          element.querySelector("img[alt]")?.getAttribute("alt")?.trim() ||
          element.querySelector("p.fw-700")?.textContent?.replace(/\s+/g, " ").trim() ||
          "";

        if (!description) {
          return null;
        }

        const quantityText =
          element
            .querySelector('[data-column-id="3"] [data-tag="allowRowEvents"], [data-column-id="3"]')
            ?.textContent?.replace(/\s+/g, " ")
            .trim() || "";
        const priceText =
          element.querySelector('[data-column-id="4"] p')?.textContent?.replace(/\s+/g, " ").trim() ||
          element.querySelector('[data-column-id="4"]')?.textContent?.replace(/\s+/g, " ").trim() ||
          "";

        return {
          description,
          quantityText,
          priceText,
        };
      })
      .filter((entry): entry is { description: string; quantityText: string; priceText: string } => Boolean(entry)),
  );

  const documentTypesByDescription = new Map<string, string[]>();
  for (const entry of documentEntries) {
    const key = normalizeFalabellaItemLabel(entry.description);
    if (!key || !entry.documentType) {
      continue;
    }
    const bucket = documentTypesByDescription.get(key) ?? [];
    bucket.push(entry.documentType);
    documentTypesByDescription.set(key, bucket);
  }
  const fallbackDocumentType = summarizeSingleFalabellaDocumentType(documentEntries);

  return rows.map((row) => {
    const quantity = Math.max(parseAmount(row.quantityText), 1);
    const lineTotal = parseAmount(row.priceText);
    const unitPrice = quantity > 0 ? roundCurrency(lineTotal / quantity) : lineTotal;
    const documentType =
      consumeFalabellaItemDocumentType(documentTypesByDescription, row.description) ?? fallbackDocumentType;

    return {
      description: row.description,
      quantity,
      unitPrice,
      total: lineTotal || roundCurrency(unitPrice * quantity),
      documentType,
    };
  });
}

function parseFalabellaDocumentProgress(raw: string): { uploaded: number; total: number; raw: string } | undefined {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/(\d+)\s+de\s+(\d+)/i);

  if (!match) {
    return undefined;
  }

  return {
    uploaded: Number(match[1]),
    total: Number(match[2]),
    raw: `${match[1]} de ${match[2]}`,
  };
}

function normalizeDetailLabel(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeFalabellaItemLabel(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeFalabellaDocumentType(raw: string | undefined): string | undefined {
  const value = (raw || "").replace(/\s+/g, " ").trim();
  const normalized = normalizeFalabellaItemLabel(value);

  if (!normalized) {
    return undefined;
  }

  if (normalized.includes("factura")) {
    return "Factura";
  }

  if (normalized.includes("boleta")) {
    return "Boleta";
  }

  return value;
}

function consumeFalabellaItemDocumentType(
  documentTypesByDescription: Map<string, string[]>,
  description: string,
): string | undefined {
  const key = normalizeFalabellaItemLabel(description);
  const bucket = documentTypesByDescription.get(key);

  if (!bucket?.length) {
    return undefined;
  }

  const documentType = normalizeFalabellaDocumentType(bucket.shift());

  if (!bucket.length) {
    documentTypesByDescription.delete(key);
  }

  return documentType;
}

function summarizeFalabellaDocumentTypes(items: SaleItem[]): string | undefined {
  const uniqueTypes = Array.from(
    new Set(items.map((item) => normalizeFalabellaDocumentType(item.documentType)).filter(Boolean)),
  );

  if (!uniqueTypes.length) {
    return undefined;
  }

  return uniqueTypes.join(", ");
}

function summarizeFalabellaDocumentTypeEntries(
  entries: Array<{ description: string; documentType?: string }>,
): string | undefined {
  const uniqueTypes = Array.from(
    new Set(entries.map((entry) => normalizeFalabellaDocumentType(entry.documentType)).filter(Boolean)),
  );

  if (!uniqueTypes.length) {
    return undefined;
  }

  return uniqueTypes.join(", ");
}

function summarizeSingleFalabellaDocumentType(
  entries: Array<{ description: string; documentType?: string }>,
): string | undefined {
  const summary = summarizeFalabellaDocumentTypeEntries(entries);
  if (!summary || summary.includes(",")) {
    return undefined;
  }

  return summary;
}

function normalizeFalabellaIssuedAt(raw: string): string {
  const value = raw.replace(/\s+/g, " ").trim();

  if (!value) {
    return new Date().toISOString();
  }

  const slashDate = value.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (slashDate) {
    const [, day, month, year] = slashDate;
    return `${year}-${month}-${day}T00:00:00-05:00`;
  }

  const monthDate = value.match(/([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (monthDate) {
    const [, rawMonth, rawDay, year, hours = "00", minutes = "00"] = monthDate;
    const month = monthTokenToNumber(rawMonth);
    const day = rawDay.padStart(2, "0");
    return `${year}-${month}-${day}T${hours.padStart(2, "0")}:${minutes}:00-05:00`;
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return new Date().toISOString();
}

function monthTokenToNumber(token: string): string {
  const months: Record<string, string> = {
    jan: "01",
    ene: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    abr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    ago: "08",
    sep: "09",
    set: "09",
    oct: "10",
    nov: "11",
    dec: "12",
    dic: "12",
  };

  return months[token.toLowerCase()] ?? "01";
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Decimales al escribir importes/precio unitario en SUNAT (evita que el total se dispare por redondeo). */
const SUNAT_CURRENCY_DECIMALS = 6;

function roundSunatAmount(value: number): number {
  const factor = 10 ** SUNAT_CURRENCY_DECIMALS;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function splitIgv(total: number): { baseAmount: number; taxAmount: number } {
  if (!total) {
    return { baseAmount: 0, taxAmount: 0 };
  }

  const baseAmount = total / 1.18;
  return {
    baseAmount,
    taxAmount: total - baseAmount,
  };
}

async function readText(scope: Page | Locator, selector: string): Promise<string> {
  const locator = scope.locator(selector).first();
  const text = await locator.textContent();
  return text?.trim() ?? "";
}

async function readOptionalText(
  scope: Page | Locator,
  selector?: string,
): Promise<string | undefined> {
  if (!selector) {
    return undefined;
  }

  const locator = scope.locator(selector).first();
  const count = await locator.count().catch(() => 0);

  if (count === 0) {
    return undefined;
  }

  const text = await locator.textContent().catch(() => null);
  return text?.trim() || undefined;
}

async function readPreferredText(params: {
  primaryScope: Page | Locator;
  primarySelector?: string;
  fallbackScope: Page | Locator;
  fallbackSelector?: string;
}): Promise<string> {
  const primaryValue = await readOptionalText(params.primaryScope, params.primarySelector);

  if (primaryValue) {
    return primaryValue;
  }

  return (await readOptionalText(params.fallbackScope, params.fallbackSelector)) ?? "";
}

async function readPreferredOptionalText(params: {
  primaryScope: Page | Locator;
  primarySelector?: string;
  fallbackScope: Page | Locator;
  fallbackSelector?: string;
}): Promise<string | undefined> {
  const primaryValue = await readOptionalText(params.primaryScope, params.primarySelector);

  if (primaryValue) {
    return primaryValue;
  }

  return readOptionalText(params.fallbackScope, params.fallbackSelector);
}

async function readPreferredAmount(params: {
  primaryScope: Page | Locator;
  primarySelector?: string;
  fallbackScope: Page | Locator;
  fallbackSelector?: string;
}): Promise<number> {
  const value = await readPreferredText(params);
  return parseAmount(value);
}

async function performLoginFlow(params: {
  page: Page;
  login: SiteProfile["seller"]["login"] | SiteProfile["sunat"]["login"];
  credentials: { username: string; password: string; ruc?: string };
  onStep: StepReporter;
  stepLabel: string;
}): Promise<void> {
  const { page, login, credentials, onStep, stepLabel } = params;

  let alreadyOnLoginSurface = await isLoginSurface(page, login);
  if (!alreadyOnLoginSurface) {
    alreadyOnLoginSurface = await waitForLoginSurfaceOrRedirect(page, login, login.loggedInSelector);
  }

  if (!alreadyOnLoginSurface) {
    try {
      await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      const interruptedByRedirect =
        /interrupted by another navigation/i.test(message) &&
        (await waitForLoginSurfaceOrRedirect(page, login, login.loggedInSelector));
      if (!interruptedByRedirect) {
        throw error;
      }
    }
  } else {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  }

  if (await isLoggedIn(page, login.loggedInSelector)) {
    return;
  }

  const usernameField = page.locator(login.usernameSelector).first();
  const passwordField = page.locator(login.passwordSelector).first();
  let shouldLogin =
    (await usernameField.isVisible().catch(() => false)) ||
    (await passwordField.isVisible().catch(() => false));

  if (!shouldLogin) {
    const visibilityChecks = [
      usernameField.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined),
      passwordField.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined),
    ];
    if (login.loggedInSelector) {
      visibilityChecks.push(
        page.locator(login.loggedInSelector).first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined),
      );
    }
    await Promise.race(visibilityChecks);
    shouldLogin =
      (await usernameField.isVisible().catch(() => false)) ||
      (await passwordField.isVisible().catch(() => false));
    if (!shouldLogin) {
      return;
    }
  }

  await onStep(stepLabel);

  if (login.rucTabSelector) {
    const rucTab = page.locator(login.rucTabSelector).first();
    if (await rucTab.isVisible().catch(() => false)) {
      await rucTab.click().catch(() => undefined);
      await page.waitForTimeout(SUNAT_TIMING.loginPostRucTabPauseMs);
    }
  }

  if (login.rucSelector && credentials.ruc) {
    await page.locator(login.rucSelector).first().fill(credentials.ruc);
  }

  if (await usernameField.isVisible().catch(() => false)) {
    await usernameField.fill(credentials.username);
  }

  if (!(await passwordField.isVisible().catch(() => false))) {
    const usernameSubmitSelector = login.usernameSubmitSelector ?? login.submitSelector;
    await page.locator(usernameSubmitSelector).first().click();
    await waitForLoginStep(page, login.passwordSelector, login.loggedInSelector);
  }

  if (await isLoggedIn(page, login.loggedInSelector)) {
    return;
  }

  await passwordField.waitFor({ state: "visible", timeout: 15_000 });
  await passwordField.fill(credentials.password);
  const submitButton = page.locator(login.passwordSubmitSelector ?? login.submitSelector).first();
  await submitButton.click();
  await waitForLoginStep(page, undefined, login.loggedInSelector);
  await page
    .waitForLoadState("networkidle", { timeout: SUNAT_TIMING.loginPostSubmitNetworkIdleTimeoutMs })
    .catch(() => undefined);

async function navigateSunatSolMenu(page: Page, labels: string[], onStep: StepReporter): Promise<void> {
  for (const label of labels) {
    await onStep(`Menú SUNAT: ${label}`);
    const target = await waitForVisibleTextTargetInPageTree(page, label, 45_000);
    await target.scrollIntoViewIfNeeded();
    await target.click();
  }

  const loginStillVisible =
    (await usernameField.isVisible().catch(() => false)) ||
    (await passwordField.isVisible().catch(() => false));
  if (!loginStillVisible) {
    return;
  }

  await onStep(`${stepLabel}: el formulario sigue visible; reintento explícito con RUC/usuario/clave.`);

  if (login.rucTabSelector) {
    const rucTab = page.locator(login.rucTabSelector).first();
    if (await rucTab.isVisible().catch(() => false)) {
      await rucTab.click().catch(() => undefined);
      await page.waitForTimeout(SUNAT_TIMING.loginPostRucTabPauseMs);
    }
  }

  if (login.rucSelector && credentials.ruc) {
    await page.locator(login.rucSelector).first().fill(credentials.ruc).catch(() => undefined);
  }
  await usernameField.fill(credentials.username).catch(() => undefined);
  await passwordField.fill(credentials.password).catch(() => undefined);
  await submitButton.click().catch(() => undefined);
  await waitForLoginStep(page, undefined, login.loggedInSelector);
  await page
    .waitForLoadState("networkidle", { timeout: SUNAT_TIMING.loginPostSubmitNetworkIdleTimeoutMs })
    .catch(() => undefined);
}

async function isLoginSurface(
  page: Page,
  login: SiteProfile["seller"]["login"] | SiteProfile["sunat"]["login"],
): Promise<boolean> {
  const usernameVisible = await page.locator(login.usernameSelector).first().isVisible().catch(() => false);
  const passwordVisible = await page.locator(login.passwordSelector).first().isVisible().catch(() => false);
  if (usernameVisible || passwordVisible) {
    return true;
  }

  const currentUrl = page.url();
  return currentUrl.startsWith(login.loginUrl) || /clientessol|user\/auth\/login/i.test(currentUrl);
}

async function waitForLoginSurfaceOrRedirect(
  page: Page,
  login: SiteProfile["seller"]["login"] | SiteProfile["sunat"]["login"],
  loggedInSelector?: string,
  timeoutMs = 8_000,
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isLoginSurface(page, login)) {
      return true;
    }
    if (loggedInSelector && (await isLoggedIn(page, loggedInSelector))) {
      return true;
    }
    await page.waitForTimeout(250).catch(() => undefined);
  }

  return isLoginSurface(page, login);
}

async function navigateSunatSolMenu(
  page: Page,
  labels: string[],
  profile: SiteProfile,
  invoiceUrl: string,
  config: AppConfig,
  onStep: StepReporter,
): Promise<void> {
  await ensureSunatMenuSurface(page, invoiceUrl, onStep, "preparar el menú SOL");
  await dismissSunatContactValidationSurface(page, onStep);

  for (let index = 0; index < labels.length; index += 1) {
    if (await isSunatBoletaWorkflowSurface(page, profile)) {
      await onStep(
        "SUNAT ya está dentro del formulario de boleta; no seguiré navegando niveles del menú SOL.",
      );
      return;
    }

    const label = labels[index];
    await onStep(`Menú SUNAT: ${label}`);
    await dismissSunatContactValidationSurface(page, onStep);
    const target = await tryFindVisibleTextTargetInPageTree(page, label, 15_000);
    if (!target) {
      await ensureSunatMenuSurface(page, invoiceUrl, onStep, `buscar el menú "${label}"`);
      await dismissSunatContactValidationSurface(page, onStep);
      if (await isSunatBoletaWorkflowSurface(page, profile)) {
        await onStep(
          `SUNAT ya quedó dentro del flujo de boleta mientras buscaba "${label}"; continuaré sin exigir más niveles del menú.`,
        );
        return;
      }
      const nextVisibleLabel = await findFirstVisibleSunatMenuLabel(page, labels.slice(index + 1), 2_000);
      if (nextVisibleLabel) {
        await onStep(
          `Menú SUNAT: no apareció "${label}", pero ya veo "${nextVisibleLabel}"; omito ese nivel y continúo.`,
        );
        continue;
      }
      const state = await describeSunatPageState(page);
      await onStep(
        `SUNAT menú: no vi "${label}". URL=${state.url || "sin URL"} · title=${state.title || "sin title"} · texto=${state.bodySnippet}.`,
      );
      await captureSunatMenuFailureEvidence(page, config, onStep, label);
      throw new Error(`No se encontró un menú SUNAT visible para "${label}".`);
    }
    await clickSunatAction(page, target, onStep, `Menú SUNAT: ${label}`);
    await page.waitForTimeout(SUNAT_TIMING.menuClickPauseMs);
  }
}

async function isSunatBoletaWorkflowSurface(
  page: Page,
  profile: SiteProfile,
  preferredScope?: PageScope,
): Promise<boolean> {
  return isAnyVisibleLocatorInPageTree(
    page,
    [
      ...customerDocumentSelectors(profile.sunat.customerDocumentSelector),
      ...customerNameSelectors(profile.sunat.customerNameSelector),
      ...customerContinueSelectors(profile.sunat.customerContinueSelector ?? "text=Continuar"),
      ...addItemButtonSelectors(profile.sunat.addItemButtonSelector),
      ...preliminarySunatStepMarkers(),
      ...finalSubmitSelectors(profile.sunat.finalSubmitSelector),
    ].filter(Boolean),
    preferredScope,
  ).catch(() => false);
}

async function findFirstVisibleSunatMenuLabel(
  page: Page,
  labels: string[],
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const label of labels) {
      const target = await tryFindVisibleTextTargetInPageTree(page, label, 100);
      if (target) {
        return label;
      }
    }
    await page.waitForTimeout(150);
  }

  return undefined;
}

async function ensureSunatMenuSurface(
  page: Page,
  invoiceUrl: string,
  onStep: StepReporter,
  contextLabel: string,
): Promise<void> {
  let state = await describeSunatPageState(page);
  if (!state.looksBlank) {
    await dismissSunatContactValidationSurface(page, onStep);
    return;
  }

  await onStep(
    `SUNAT parece en blanco al ${contextLabel}; recargaré la vista. URL=${state.url || "sin URL"} · title=${state.title || "sin title"}.`,
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(500).catch(() => undefined);
  state = await describeSunatPageState(page);
  if (!state.looksBlank) {
    return;
  }

  await onStep(
    `SUNAT sigue en blanco tras recargar; abriré directamente ${invoiceUrl}.`,
  );
  await page.goto(invoiceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(750).catch(() => undefined);
  state = await describeSunatPageState(page);
  await dismissSunatContactValidationSurface(page, onStep);
  await onStep(
    `Estado SUNAT tras recuperación: URL=${state.url || "sin URL"} · title=${state.title || "sin title"} · texto=${state.bodySnippet}.`,
  );
}

function shouldRetrySunatHeadfulAfterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /ERR_CONNECTION_RESET|chrome-error:\/\/chromewebdata|ERR_HTTP2_PROTOCOL_ERROR/i.test(message);
}

async function shouldRetrySunatInHeadful(page: Page): Promise<boolean> {
  if (page.isClosed()) {
    return false;
  }
  const state = await describeSunatPageState(page);
  return page.url().startsWith("chrome-error://") || state.looksBlank;
}

async function describeSunatPageState(page: Page): Promise<{
  url: string;
  title: string;
  bodySnippet: string;
  looksBlank: boolean;
}> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = ((await page.locator("body").textContent().catch(() => "")) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const bodySnippet = bodyText ? truncateForLog(bodyText, 180) : "sin texto visible";
  const looksBlank = !title.trim() && bodyText.length < 20;

  return {
    url,
    title: title.trim(),
    bodySnippet,
    looksBlank,
  };
}

async function captureSunatMenuFailureEvidence(
  page: Page,
  config: AppConfig,
  onStep: StepReporter,
  label: string,
): Promise<void> {
  const screenshotPath = path.join(
    config.dataPaths.screenshotsDir,
    `sunat-menu-failure-${Date.now()}.png`,
  );
  const frameSummary = page
    .frames()
    .map((frame, index) => `[${index}] ${frame.url() || "about:blank"}`)
    .slice(0, 12)
    .join(" | ");
  const visibleControls = await describeVisibleControlsInPageTree(page);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  await onStep(
    `SUNAT menú fallo "${label}": frames=${frameSummary || "sin frames"} · controles=${visibleControls}.`,
  );
  if (fs.existsSync(screenshotPath)) {
    await onStep(`SUNAT menú fallo "${label}": screenshot guardado en ${screenshotPath}.`);
  }
}

/**
 * Cierra en segundo plano el flujo «Valida tus datos de contacto» (modal informativo + «Continuar sin confirmar»).
 * Debe ejecutarse en cada marco: la campaña suele cargarse en un iframe cross-origin (p. ej. ifrVCE → ww1.sunat.gob.pe);
 * desde el top no se puede leer ese documento, pero addInitScript corre también al cargar el iframe.
 * Emite logs simples de búsqueda/cierre para que el dashboard muestre el estado real del iframe y del modal.
 */
async function installSunatContactValidationModalDismisser(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    if (typeof window === "undefined") {
      return;
    }

    const installKey = "__automateSunatContactValidationDismiss";
    const win = window as unknown as Record<string, unknown>;
    if (win[installKey]) {
      return;
    }
    win[installKey] = true;

    let tickSeq = 0;
    const POLL_INTERVAL_MS = 750;
    const POLL_INTERVAL_LABEL = "0.75 s";

    function logTraceBlock(_lines: string[]): void {
      /* trace logging intentionally disabled; keep simple live logs only */
    }

    (function logInstallBanner(): void {
      const isTop = window === window.top;
      let host = "";
      try {
        host = window.location.hostname || "(sin host)";
      } catch {
        host = "?";
      }
      const lines = [
        "━━ Vigilante instalado en este marco (se repite en TOP y dentro de cada iframe al cargar) ━━",
        isTop
          ? "TOP: en esta vista buscamos #divModalCampana y #ifrVCE. El iframe apunta a otro sitio; el navegador no deja leer su DOM desde aquí, pero el mismo script corre dentro del iframe cuando esa URL carga — allí se detectan y cierran los modales."
          : "IFRAME: este documento es el de la URL del iframe (p. ej. campaña ww1.sunat…). Aquí están los botones; el TOP solo ve el marco vacío desde fuera.",
        `Marco actual: ${isTop ? "TOP (principal)" : "IFRAME (interior)"} · host=${host}`,
      ];
      logTraceBlock(lines);
    })();

    function hostnameLooksLikeSunat(): boolean {
      try {
        return /sunat/i.test(window.location.hostname || "");
      } catch {
        return false;
      }
    }

    function collectAccessibleDocuments(root: Window, acc: Document[], seen: Set<Window>): void {
      if (seen.has(root)) {
        return;
      }
      seen.add(root);
      try {
        acc.push(root.document);
      } catch {
        return;
      }
      for (let i = 0; i < root.frames.length; i += 1) {
        try {
          collectAccessibleDocuments(root.frames[i] as Window, acc, seen);
        } catch {
          /* cross-origin */
        }
      }
    }

    function elementLooksVisibleInDocument(el: HTMLElement, doc: Document): boolean {
      if (!doc.documentElement.contains(el)) {
        return false;
      }
      const view = doc.defaultView;
      if (!view) {
        return false;
      }
      const cs = view.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) {
        return false;
      }
      if (el.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) {
        return false;
      }
      if (el.hasAttribute("disabled")) {
        return false;
      }
      return true;
    }

    function hideBlockingSurface(el: HTMLElement, trace: string[], label: string): void {
      el.setAttribute("aria-hidden", "true");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("opacity", "0", "important");
      el.style.setProperty("pointer-events", "none", "important");
      trace.push(`   · ${label}: oculto visualmente (visibility:hidden, opacity:0, pointer-events:none).`);
    }

    function clickElement(el: HTMLElement, trace: string[], label: string): boolean {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
      } catch {
        /* ignore */
      }

      try {
        el.click();
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        trace.push(`   · ${label}: click disparado.`);
        return true;
      } catch (error) {
        trace.push(`   · ${label}: falló el click (${String((error as Error)?.message || error)}).`);
        return false;
      }
    }

    function tryDismissContactValidationModals(): void {
      tickSeq += 1;
      const isTop = window === window.top;
      let host = "";
      let pathSnippet = "";
      try {
        host = window.location.hostname || "";
        pathSnippet = (window.location.pathname || "").slice(0, 96);
      } catch {
        /* ignore */
      }

      const trace: string[] = [];
      trace.push(
        `[cada ${POLL_INTERVAL_LABEL}] Ciclo #${tickSeq} — se ejecuta el método de vigilancia (setInterval ${POLL_INTERVAL_MS} ms). En este ciclo busco: en TOP → #divModalCampana y iframe id="ifrVCE"; en cada marco → botones del modal.`,
      );
      trace.push(
        `Paso 0 · Marco: ${isTop ? "TOP (ventana principal)" : "IFRAME/submarco"} · host=${host || "?"} · ruta=${pathSnippet || "?"}`,
      );

      const sunatOk = hostnameLooksLikeSunat();
      trace.push(
        `Paso 1 · ¿Hostname SUNAT? → ${sunatOk ? "sí · continúo búsqueda de botones" : "no · no aplica campaña aquí; fin de este ciclo"}`,
      );
      if (!sunatOk) {
        trace.push(
          `Fin ciclo #${tickSeq} · próxima pasada del mismo método en ~${POLL_INTERVAL_LABEL} (setInterval ${POLL_INTERVAL_MS} ms). En host SUNAT se buscaría #ifrVCE en TOP.`,
        );
        logTraceBlock(trace);
        return;
      }

      if (isTop) {
        trace.push(
          "Paso 2 · Desde TOP: localizar contenedor de campaña SUNAT y el iframe de validación de datos.",
        );
        try {
          trace.push("Paso 2a · Busco #divModalCampana (contenedor del modal de campaña / validación de contacto)…");
          const divModalCampana = document.getElementById("divModalCampana");
          if (!divModalCampana) {
            trace.push("   · resultado: #divModalCampana no está en el DOM de este documento.");
            trace.push("   · nota: si el menú SUNAT está en otro marco, ese documento es el que debe tener este div.");
          } else {
            trace.push("   · resultado: #divModalCampana encontrado.");
            if (divModalCampana instanceof HTMLElement) {
              const cs = window.getComputedStyle(divModalCampana);
              trace.push(
                `   · caja: class="${(divModalCampana.getAttribute("class") || "").slice(0, 60)}" · display=${cs.display} · visibility=${cs.visibility}`,
              );
              const inTree = document.documentElement.contains(divModalCampana);
              trace.push(`   · conectado al documento actual: ${inTree ? "sí" : "no"}`);
              trace.push("   · mantengo visible #divModalCampana hasta intentar clickear los botones del flujo.");
            }
          }

          trace.push(
            "Paso 2b · Busco #ifrVCE (name=ifrVCE) dentro de #divModalCampana; si falta el div, busco #ifrVCE en todo el documento…",
          );
          let ifrVce: HTMLIFrameElement | null = null;
          let ifrVcePath = "";
          if (divModalCampana) {
            ifrVce = divModalCampana.querySelector("#ifrVCE") as HTMLIFrameElement | null;
            if (ifrVce) {
              ifrVcePath = "descendiente directo/indirecto de #divModalCampana";
            }
          }
          if (!ifrVce) {
            const globalIfr = document.getElementById("ifrVCE");
            if (globalIfr instanceof HTMLIFrameElement) {
              ifrVce = globalIfr;
              if (divModalCampana && divModalCampana.contains(globalIfr)) {
                ifrVcePath = "#ifrVCE en documento, contenido en #divModalCampana";
              } else if (divModalCampana) {
                ifrVcePath =
                  "#ifrVCE en documento pero fuera de #divModalCampana (revisar estructura HTML)";
              } else {
                ifrVcePath = "#ifrVCE en documento (sin #divModalCampana previo)";
              }
            }
          }

          if (!ifrVce) {
            trace.push(
              `RESULTADO búsqueda id="ifrVCE": NO ENCONTRADO en el DOM de esta página (TOP). No hay ningún elemento con id ifrVCE todavía, o estás en otra vista. El mismo método volverá a buscar en ~${POLL_INTERVAL_LABEL}.`,
            );
          } else {
            const nm = ifrVce.getAttribute("name") || "";
            trace.push(
              `RESULTADO búsqueda id="ifrVCE": ENCONTRADO (${ifrVcePath}). El iframe está en el árbol HTML; el contenido interno se maneja en el marco hijo.`,
            );
            trace.push(`   · detalle: id=ifrVCE name=${nm || "—"}`);
            const srcAttr = (ifrVce.getAttribute("src") || "").slice(0, 160);
            trace.push(`   · src (recortado): ${srcAttr || "(vacío)"}`);
            trace.push("   · mantengo visible el iframe hasta intentar cerrar el flujo de contacto.");
            let access = "";
            try {
              access = ifrVce.contentDocument
                ? "contentDocument accesible (mismo origen)"
                : "contentDocument null → cross-origin esperado (ww1.sunat…); los botones se cierran desde el init dentro de ese marco";
            } catch {
              access = "no se pudo leer contentDocument (cross-origin)";
            }
            trace.push(`   · ${access}`);
          }

          trace.push("Paso 2c · Resumen: todos los iframe del documento TOP (orden de aparición en DOM)…");
          const iframes = Array.prototype.slice.call(document.querySelectorAll("iframe"));
          trace.push(`   · total iframes en página: ${iframes.length}`);
          for (let i = 0; i < iframes.length; i += 1) {
            const el = iframes[i] as HTMLIFrameElement;
            const id = el.id || "—";
            const nm = el.name || "—";
            const src = (el.getAttribute("src") || "").slice(0, 100);
            let access = "";
            try {
              access = el.contentDocument
                ? "contentDocument OK (mismo origen)"
                : "contentDocument null (cross-origin típico)";
            } catch {
              access = "error al leer (cross-origin)";
            }
            const campaña =
              /campanh|modifdatos|ifrVCE/i.test(`${id} ${nm} ${src}`) ? " · campaña/modifdatos" : "";
            trace.push(`   · [${i}] id=${id} name=${nm} · ${access}${campaña}`);
            trace.push(`     src=${src || "—"}`);
          }
        } catch (e) {
          trace.push(`   · error en Paso 2 (modal/iframes): ${String((e as Error)?.message || e)}`);
        }
      } else {
        trace.push(
          "Paso 2 · Dentro de IFRAME (p. ej. documento cargado en #ifrVCE): #divModalCampana y el wrapper del iframe solo existen en el documento TOP.",
        );
        trace.push(
          "   · aquí no busco #divModalCampana; el vigilante en TOP ya registró ese contenedor; en este marco busco los botones del formulario.",
        );
      }

      const docs: Document[] = [];
      try {
        collectAccessibleDocuments(window, docs, new Set());
      } catch (e) {
        trace.push(`Paso 3 · Error recopilando documentos same-origin: ${String((e as Error)?.message || e)}`);
        trace.push(
          `Fin ciclo #${tickSeq} · próxima pasada del mismo método en ~${POLL_INTERVAL_LABEL} (setInterval ${POLL_INTERVAL_MS} ms).`,
        );
        logTraceBlock(trace);
        return;
      }
      trace.push(`Paso 3 · Documentos same-origin desde este marco: ${docs.length}`);
      for (let i = 0; i < docs.length; i += 1) {
        const d = docs[i];
        let href = "";
        try {
          href = (d.defaultView?.location?.href ?? d.URL ?? "").slice(0, 140);
        } catch {
          href = "(href no accesible)";
        }
        trace.push(`   · doc[${i}]: ${href}`);
      }

      trace.push("Paso 4 · Buscar #btnFinalizarValidacionDatos (visible) por documento…");
      let anyFinalizarNode = false;
      let clickedFinalizar = false;
      for (let d = 0; d < docs.length; d += 1) {
        const doc = docs[d];
        const el = doc.getElementById("btnFinalizarValidacionDatos");
        if (!el) {
          trace.push(`   · doc[${d}]: sin nodo con ese id`);
          continue;
        }
        anyFinalizarNode = true;
        const vis = el instanceof HTMLElement && elementLooksVisibleInDocument(el, doc);
        trace.push(`   · doc[${d}]: nodo presente · visible=${vis ? "SÍ (acción: click Finalizar)" : "no"}`);
        if (vis && el instanceof HTMLElement && clickElement(el, trace, `doc[${d}] #btnFinalizarValidacionDatos`)) {
          clickedFinalizar = true;
          break;
        }
      }
      if (!anyFinalizarNode) {
        trace.push("   · ningún doc tiene #btnFinalizarValidacionDatos");
      }

      if (!clickedFinalizar) {
        trace.push("Paso 4b · Buscar botón visible con texto «Finalizar» en documentos same-origin…");
        for (let d = 0; d < docs.length; d += 1) {
          const doc = docs[d];
          const candidates = Array.from(
            doc.querySelectorAll<HTMLElement>("button, input[type='button'], input[type='submit'], a, span"),
          );
          const target = candidates.find((candidate) => {
            const label = (
              candidate.textContent ||
              candidate.getAttribute("value") ||
              candidate.getAttribute("aria-label") ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim();
            return /finalizar/i.test(label) && elementLooksVisibleInDocument(candidate, doc);
          });
          if (!target) {
            trace.push(`   · doc[${d}]: no veo botón «Finalizar» accionable`);
            continue;
          }
          if (clickElement(target, trace, `doc[${d}] botón "Finalizar"`)) {
            clickedFinalizar = true;
            break;
          }
        }
      }

      trace.push('Paso 5 · Buscar #btnCerrar coherente (onclick callHide o texto «Continuar sin confirmar»)…');
      let anyCerrarNode = false;
      let clickedCerrar = false;
      for (let d = 0; d < docs.length; d += 1) {
        const doc = docs[d];
        const el = doc.getElementById("btnCerrar");
        if (!el) {
          trace.push(`   · doc[${d}]: sin #btnCerrar`);
          continue;
        }
        anyCerrarNode = true;
        const onclick = el.getAttribute("onclick") || "";
        const label = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const matches =
          el instanceof HTMLElement &&
          (onclick.includes("callHide") || /continuar\s+sin\s+confirmar/i.test(label));
        const vis = el instanceof HTMLElement && elementLooksVisibleInDocument(el, doc);
        trace.push(
          `   · doc[${d}]: btnCerrar presente · coincide patrón=${matches ? "sí" : "no"} · visible=${vis ? "SÍ" : "no"} · texto=${label || "—"}`,
        );
        if (matches && vis && el instanceof HTMLElement && clickElement(el, trace, `doc[${d}] #btnCerrar`)) {
          clickedCerrar = true;
          break;
        }
      }
      if (!anyCerrarNode) {
        trace.push("   · ningún doc tiene #btnCerrar");
      }

      if (!clickedCerrar) {
        trace.push('Paso 5b · Buscar botón visible con texto «Continuar sin confirmar»…');
        for (let d = 0; d < docs.length; d += 1) {
          const doc = docs[d];
          const candidates = Array.from(
            doc.querySelectorAll<HTMLElement>("button, input[type='button'], input[type='submit'], a, span"),
          );
          const target = candidates.find((candidate) => {
            const label = (
              candidate.textContent ||
              candidate.getAttribute("value") ||
              candidate.getAttribute("aria-label") ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim();
            return /continuar\s+sin\s+confirmar/i.test(label) && elementLooksVisibleInDocument(candidate, doc);
          });
          if (!target) {
            trace.push(`   · doc[${d}]: no veo botón «Continuar sin confirmar» accionable`);
            continue;
          }
          if (clickElement(target, trace, `doc[${d}] botón "Continuar sin confirmar"`)) {
            clickedCerrar = true;
            break;
          }
        }
      }

      if (clickedFinalizar || clickedCerrar) {
        const topCampana = document.getElementById("divModalCampana");
        if (topCampana instanceof HTMLElement) {
          hideBlockingSurface(topCampana, trace, "#divModalCampana");
        }
        const topIframe = document.getElementById("ifrVCE");
        if (topIframe instanceof HTMLElement) {
          hideBlockingSurface(topIframe, trace, "#ifrVCE");
        }
      }

      trace.push(
        `Fin ciclo #${tickSeq} · próxima pasada del mismo método en ~${POLL_INTERVAL_LABEL} (setInterval ${POLL_INTERVAL_MS} ms; en TOP SUNAT se vuelve a buscar id="ifrVCE").`,
      );
      logTraceBlock(trace);

    }

    window.setInterval(tryDismissContactValidationModals, POLL_INTERVAL_MS);
    tryDismissContactValidationModals();
  });
}

async function dismissSunatNotificationsPrompt(page: Page, onStep?: StepReporter): Promise<void> {
  const button = await tryFindVisibleTextTargetInPageTree(page, "Ver más tarde", 2_500);

  if (!button) {
    return;
  }

  await onStep?.("SUNAT mostró el aviso del buzón electrónico; haré click en Ver más tarde.");
  await button.scrollIntoViewIfNeeded().catch(() => undefined);
  await button.click().catch(() => undefined);
}

async function waitForVisibleTextTargetInPageTree(
  page: Page,
  label: string,
  timeoutMs: number,
): Promise<Locator> {
  const target = await tryFindVisibleTextTargetInPageTree(page, label, timeoutMs);
  if (target) {
    return target;
  }

  throw new Error(`No se encontró un menú SUNAT visible para "${label}".`);
}

async function tryFindVisibleTextTargetInPageTree(
  page: Page,
  label: string,
  timeoutMs: number,
): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const scope of collectPageScopes(page)) {
      const candidates = [
        scope.getByRole("link", { name: label, exact: true }),
        scope.getByRole("button", { name: label, exact: true }),
        scope.getByText(label, { exact: true }),
        scope.getByText(label),
      ];

      for (const candidate of candidates) {
        const count = await candidate.count().catch(() => 0);

        for (let index = 0; index < Math.min(count, 20); index += 1) {
          const match = candidate.nth(index);
          if (await match.isVisible().catch(() => false)) {
            return match;
          }
        }
      }
    }

    await page.waitForTimeout(250);
  }

  return undefined;
}

async function waitForVisibleLocatorInPageTree(
  page: Page,
  selector: string,
  timeoutMs: number,
  preferredScope?: PageScope,
): Promise<{ scope: PageScope; locator: Locator }> {
  return waitForAnyVisibleLocatorInPageTree(page, [selector], timeoutMs, preferredScope);
}

async function waitForAnyVisibleLocatorInPageTree(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  preferredScope?: PageScope,
): Promise<{ scope: PageScope; locator: Locator }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const scopes = preferredScope
      ? [preferredScope, ...collectPageScopes(page).filter((scope) => scope !== preferredScope)]
      : collectPageScopes(page);

    for (const scope of scopes) {
      for (const selector of selectors) {
        const locator = scope.locator(selector);
        const count = await locator.count().catch(() => 0);

        if (!count) {
          continue;
        }

        for (let index = 0; index < Math.min(count, 20); index += 1) {
          const candidate = locator.nth(index);
          if (await candidate.isVisible().catch(() => false)) {
            return { scope, locator: candidate };
          }
        }
      }
    }

    await page.waitForTimeout(250);
  }

  const visibleControlSummary = await describeVisibleControlsInPageTree(page);
  throw new Error(
    `No se encontró un elemento visible para ninguno de los selectores: ${selectors.join(" | ")}\nControles visibles detectados: ${visibleControlSummary}`,
  );
}

async function waitForAnyVisibleLocatorWithinRoot(
  root: Locator,
  selectors: string[],
  timeoutMs: number,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = root.locator(selector);
      const count = await locator.count().catch(() => 0);

      if (!count) {
        continue;
      }

      for (let index = 0; index < Math.min(count, 20); index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No se encontró un elemento visible dentro del contenedor para: ${selectors.join(" | ")}`);
}

async function waitForBottomMostVisibleLocatorInPageTree(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  preferredScope?: PageScope,
): Promise<{ scope: PageScope; locator: Locator }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const scopes = preferredScope
      ? [preferredScope, ...collectPageScopes(page).filter((scope) => scope !== preferredScope)]
      : collectPageScopes(page);

    let bestMatch: { scope: PageScope; locator: Locator; score: number } | null = null;

    for (const scope of scopes) {
      for (const selector of selectors) {
        const locator = scope.locator(selector);
        const count = await locator.count().catch(() => 0);

        if (!count) {
          continue;
        }

        for (let index = 0; index < Math.min(count, 20); index += 1) {
          const candidate = locator.nth(index);
          if (!(await candidate.isVisible().catch(() => false))) {
            continue;
          }

          const box = await candidate.boundingBox().catch(() => null);
          const score = (box?.y ?? 0) + (box?.height ?? 0);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { scope, locator: candidate, score };
          }
        }
      }
    }

    if (bestMatch) {
      return { scope: bestMatch.scope, locator: bestMatch.locator };
    }

    await page.waitForTimeout(250);
  }

  return waitForAnyVisibleLocatorInPageTree(page, selectors, 1_000, preferredScope);
}

async function tryWaitForBottomMostVisibleLocatorInPageTree(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  preferredScope?: PageScope,
): Promise<{ scope: PageScope; locator: Locator } | null> {
  try {
    return await waitForBottomMostVisibleLocatorInPageTree(page, selectors, timeoutMs, preferredScope);
  } catch {
    return null;
  }
}

async function tryWaitForVisibleLocatorInPageTree(
  page: Page,
  selector: string,
  timeoutMs: number,
  preferredScope?: PageScope,
): Promise<{ scope: PageScope; locator: Locator } | null> {
  try {
    return await waitForVisibleLocatorInPageTree(page, selector, timeoutMs, preferredScope);
  } catch {
    return null;
  }
}

async function tryWaitForAnyVisibleLocatorInPageTree(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  preferredScope?: PageScope,
): Promise<{ scope: PageScope; locator: Locator } | null> {
  try {
    return await waitForAnyVisibleLocatorInPageTree(page, selectors, timeoutMs, preferredScope);
  } catch {
    return null;
  }
}

async function waitForAutofilledCustomerName(
  page: Page,
  selectors: string[],
  expectedName: string,
  preferredScope?: PageScope,
  onStep?: StepReporter,
  sunatInconsistentDniRecovery?: { profile: SiteProfile; draft: InvoiceDraft },
): Promise<{ scope: PageScope; locator: Locator }> {
  let field = await waitForAnyVisibleLocatorInPageTree(page, selectors, 8_000, preferredScope);
  const deadline = Date.now() + 15_000;
  const expected = normalizeComparableText(expectedName);
  const fieldIdentity = await describeLocatorIdentity(field.locator);
  let nextProgressLogAt = Date.now();
  let nextModalAbsentLogAt = Date.now() + 6_000;

  if (sunatInconsistentDniRecovery) {
    const rawDoc = sunatInconsistentDniRecovery.draft.customer.documentNumber || "";
    await onStep?.(
      `SUNAT: esperando el nombre del cliente en ${fieldIdentity}. Si SUNAT muestra el modal «documento de identidad inconsistente», omitiré esta venta y seguiré con las demás (${truncateForLog(rawDoc, 24)}).`,
    );
  }

  while (Date.now() < deadline) {
    if (sunatInconsistentDniRecovery) {
      const recovered = await tryRecoverSunatInconsistentIdentityModal(
        page,
        sunatInconsistentDniRecovery.profile,
        sunatInconsistentDniRecovery.draft,
        onStep,
      );
      if (recovered) {
        const refreshed = await tryWaitForAnyVisibleLocatorInPageTree(
          page,
          selectors,
          5_000,
          preferredScope,
        );
        if (refreshed) {
          field = refreshed;
        }
      } else if (Date.now() >= nextModalAbsentLogAt) {
        await onStep?.(
          "SUNAT modal inconsistencia: nombre aún vacío y no veo ese aviso en ningún marco; sigo esperando autocompletado o el modal.",
        );
        nextModalAbsentLogAt = Date.now() + 6_000;
      }
    }

    const value = await readLocatorValue(field.locator);
    const normalizedValue = normalizeComparableText(value);

    if (normalizedValue) {
      await onStep?.(`Nombre del cliente listo en SUNAT (${fieldIdentity}): ${truncateForLog(value, 80)}`);
      if (
        !expected ||
        normalizedValue.includes(expected) ||
        expected.includes(normalizedValue)
      ) {
        return field;
      }

      // SUNAT puede autocompletar el nombre con un formato distinto al esperado;
      // si el campo ya trae contenido, continuamos con el flujo.
      return field;
    }

    if (Date.now() >= nextProgressLogAt) {
      await onStep?.(`Esperando que SUNAT complete el nombre del cliente (${fieldIdentity}).`);
      nextProgressLogAt = Date.now() + 3_000;
    }

    await page.waitForTimeout(250);
  }

  if (expectedName.trim()) {
    await onStep?.(
      `SUNAT no autocompletó el nombre a tiempo; intentaré usar el nombre del draft manualmente en ${fieldIdentity}.`,
    );

    const editable = await field.locator.isEditable().catch(() => false);
    if (editable) {
      await field.locator.click().catch(() => undefined);
      await field.locator.fill(expectedName).catch(() => undefined);
      await field.locator.press("Tab").catch(() => undefined);
    } else {
      await field.locator
        .evaluate((element, value) => {
          if (!(element instanceof HTMLInputElement)) {
            throw new Error("El campo de nombre no es un input editable.");
          }
          element.removeAttribute("disabled");
          element.removeAttribute("aria-disabled");
          element.disabled = false;
          element.value = value;
          element.setAttribute("value", value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          element.dispatchEvent(new Event("blur", { bubbles: true }));
        }, expectedName)
        .catch(() => undefined);
    }

    await page.waitForTimeout(300).catch(() => undefined);
    const fallbackValue = await readLocatorValue(field.locator);
    if (normalizeComparableText(fallbackValue)) {
      await onStep?.(`SUNAT: nombre cargado manualmente en ${fieldIdentity}: ${truncateForLog(fallbackValue, 80)}`);
      return field;
    }
  }

  const docHint =
    sunatInconsistentDniRecovery?.draft.customer.documentNumber !== undefined
      ? ` Cliente: ${truncateForLog(sunatInconsistentDniRecovery.draft.customer.documentNumber, 32)} (${sunatInconsistentDniRecovery.draft.customer.documentNumber.replace(/\D+/g, "").length} dígitos).`
      : "";
  throw new Error(
    `SUNAT no cargó el nombre del cliente (nombre esperado: ${expectedName || "sin nombre esperado"}).${docHint}`,
  );
}

/** Texto del modal cuando SUNAT no encuentra o no valida el documento del cliente (flujo boleta). */
const SUNAT_INCONSISTENT_IDENTITY_MODAL_RE = /documento\s+de\s+identidad\s+inconsistente/i;

/** Texto visible del combo + `input[type=hidden][name=tipoDocumento]` para el código (p. ej. value 1 = DNI); no siempre hay `<select>`. */
const SUNAT_INICIO_TIPO_DOCUMENTO_ID_XPATH = 'xpath=//*[@id="inicio.tipoDocumento"]';

async function resolveSunatInicioTipoDocumentoControls(
  page: Page,
  timeoutMs: number,
  onStep?: StepReporter,
): Promise<{ fieldLoc: Locator; widgetLoc: Locator }> {
  const widgetSelector = "#widget_inicio\\.tipoDocumento";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const scope of collectPageScopes(page)) {
      const fieldLoc = scope.locator(SUNAT_INICIO_TIPO_DOCUMENTO_ID_XPATH).first();
      const widgetLoc = scope.locator(widgetSelector).first();
      const hasField = (await fieldLoc.count().catch(() => 0)) > 0;
      const widgetVisible = await widgetLoc.isVisible().catch(() => false);

      if (hasField || widgetVisible) {
        const tagHint = hasField
          ? await fieldLoc.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => "?")
          : "—";
        await onStep?.(
          `SUNAT: control id=inicio.tipoDocumento (${hasField ? `en DOM, etiqueta <${tagHint}>` : "aún no en DOM"}, widget #widget_inicio.tipoDocumento ${widgetVisible ? "visible" : "no visible"} en ${describePageScopeForLog(scope)}).`,
        );
        return { fieldLoc, widgetLoc };
      }
    }
    await page.waitForTimeout(200);
  }

  throw new Error(
    'Tras cerrar el modal no apareció el control id="inicio.tipoDocumento" ni el widget #widget_inicio.tipoDocumento en ningún marco.',
  );
}

async function selectSunatInicioTipoDocumentoByLabel(
  page: Page,
  targetLabel: string,
  onStep?: StepReporter,
): Promise<void> {
  const normalizedTarget = targetLabel
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const aliasTargets =
    normalizedTarget === "documento nacional de identidad"
      ? [normalizedTarget, "doc. nacional de identidad", "dni"]
      : normalizedTarget === "registro unico de contribuyentes"
        ? [normalizedTarget, "ruc"]
        : [normalizedTarget];

  await onStep?.(
    `SUNAT: elijo «${targetLabel}»: hago clic en el campo id="inicio.tipoDocumento" (input/combo) para abrir la lista y selecciono la opción.`,
  );

  const { fieldLoc, widgetLoc } = await resolveSunatInicioTipoDocumentoControls(page, 30_000, onStep);

  async function clickMenuSinDocumento(): Promise<boolean> {
    for (const scope of collectPageScopes(page)) {
      const candidates = scope.locator(
        [
          ".dijitMenuPopup:visible .dijitMenuItemLabel",
          ".dijitMenuPopup:visible td.dijitMenuItemLabel",
          ".dijitMenu:visible .dijitMenuItemLabel",
          ".dijitMenu:visible td.dijitMenuItemLabel",
          ".dijitSelectMenu:visible .dijitMenuItemLabel",
          ".dijitComboBoxMenu:visible .dijitMenuItemLabel",
        ].join(", "),
      );
      const n = await candidates.count().catch(() => 0);
      for (let i = 0; i < n; i += 1) {
        const cell = candidates.nth(i);
        if (!(await cell.isVisible().catch(() => false))) {
          continue;
        }
        const raw = (await cell.textContent().catch(() => "")) || "";
        const norm = raw
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!aliasTargets.some((alias) => norm.includes(alias))) {
          continue;
        }
        await onStep?.(`SUNAT: en la lista abierta elijo «${raw.trim()}».`);
        await cell.click({ timeout: 8_000 }).catch(() => cell.click({ force: true }));
        return true;
      }
    }
    return false;
  }

  async function openDropdown(): Promise<void> {
    const arrow = widgetLoc.locator(".dijitDownArrowButton, .dijitArrowButton, .dijitArrowButtonContainer").first();

    if (await arrow.isVisible().catch(() => false)) {
      await onStep?.("SUNAT: clic en la flecha del combo de tipo de documento para abrir el combobox.");
      await arrow.scrollIntoViewIfNeeded().catch(() => undefined);
      await arrow.click({ timeout: 12_000 }).catch(async () => {
        await onStep?.("SUNAT: reintento clic en la flecha del combo (force).");
        await arrow.click({ force: true, timeout: 8_000 }).catch(() => undefined);
      });
      return;
    }

    await onStep?.(
      "SUNAT: clic en el campo id=inicio.tipoDocumento (input/combo) para abrir la lista de opciones.",
    );
    if ((await fieldLoc.count().catch(() => 0)) > 0) {
      await fieldLoc.scrollIntoViewIfNeeded().catch(() => undefined);
      const inputVisible = await fieldLoc.isVisible().catch(() => false);
      await fieldLoc
        .click({ timeout: 12_000, force: !inputVisible })
        .catch(async () => {
          await onStep?.("SUNAT: segundo intento de clic en id=inicio.tipoDocumento (force).");
          await fieldLoc.click({ force: true, timeout: 8_000 }).catch(() => undefined);
        });
      return;
    }
    if (await widgetLoc.isVisible().catch(() => false)) {
      await widgetLoc.scrollIntoViewIfNeeded().catch(() => undefined);
      await widgetLoc.click({ timeout: 12_000 }).catch(async () => {
        await onStep?.("SUNAT: clic en #widget_inicio.tipoDocumento; el input aún no está en el DOM.");
        await widgetLoc.click({ force: true, timeout: 8_000 }).catch(() => undefined);
      });
    }
  }

  await openDropdown();
  await page.waitForTimeout(450);

  if (await clickMenuSinDocumento()) {
    await page.waitForTimeout(200);
    await onStep?.(`SUNAT: quedó «${targetLabel}» en tipo de documento (id=inicio.tipoDocumento).`);
    return;
  }

  await onStep?.("SUNAT: no vi la opción en la lista; repito clic para abrir el desplegable.");
  await openDropdown();
  await page.waitForTimeout(450);

  if (await clickMenuSinDocumento()) {
    await page.waitForTimeout(200);
    await onStep?.(`SUNAT: quedó «${targetLabel}» en tipo de documento (id=inicio.tipoDocumento).`);
    return;
  }

  const arrow = widgetLoc.locator(".dijitDownArrowButton, .dijitArrowButton, .dijitArrowButtonContainer").first();
  if (await arrow.isVisible().catch(() => false)) {
    await onStep?.("SUNAT: abro con la flecha del combo.");
    await arrow.click().catch(() => undefined);
    await page.waitForTimeout(400);
    if (await clickMenuSinDocumento()) {
      await page.waitForTimeout(200);
      await onStep?.(`SUNAT: quedó «${targetLabel}» vía flecha del combo.`);
      return;
    }
  }

  const domFallback = await fieldLoc
    .evaluate((root, targetAliases: string[]) => {
      const from = root as Element;

      function normText(s: string): string {
        return s
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      }

      function findHiddenTipoDocumento(el: Element): HTMLInputElement | null {
        const widget = el.closest("[widgetid]");
        const hW = widget?.querySelector('input[type="hidden"][name="tipoDocumento"]');
        if (hW instanceof HTMLInputElement) {
          return hW;
        }
        let p: Element | null = el.parentElement;
        for (let depth = 0; depth < 12 && p; depth += 1) {
          const h = p.querySelector('input[type="hidden"][name="tipoDocumento"]');
          if (h instanceof HTMLInputElement) {
            return h;
          }
          p = p.parentElement;
        }
        const g = document.querySelector('input[type="hidden"][name="tipoDocumento"]');
        return g instanceof HTMLInputElement ? g : null;
      }

      function findTargetPair(): { value: string; label: string } | null {
        const roots: Element[] = [];
        const w = from.closest("[widgetid]");
        if (w) {
          roots.push(w);
        }
        const form = from.closest("form");
        if (form) {
          roots.push(form);
        }
        roots.push(document.body);

        const seen = new Set<Element>();
        for (const c of roots) {
          if (seen.has(c)) {
            continue;
          }
          seen.add(c);
          for (const sel of Array.from(c.querySelectorAll("select"))) {
            for (const opt of Array.from(sel.options)) {
              const t = normText(opt.label || opt.textContent || "");
              if (aliases.some((alias) => t.includes(alias))) {
                const label = (opt.label || opt.textContent || "").replace(/\s+/g, " ").trim();
                return { value: opt.value, label };
              }
            }
          }
        }

        for (const sel of Array.from(document.querySelectorAll("select"))) {
          for (const opt of Array.from(sel.options)) {
            const t = normText(opt.label || opt.textContent || "");
            if (aliases.some((alias) => t.includes(alias))) {
              const label = (opt.label || opt.textContent || "").replace(/\s+/g, " ").trim();
              return { value: opt.value, label };
            }
          }
        }
        return null;
      }

      const aliases = targetAliases;
      const pair = findTargetPair();
      if (!pair) {
        return { ok: false as const, reason: "sin-par-en-selects" };
      }

      const hidden = findHiddenTipoDocumento(from);
      const textBox =
        document.getElementById("inicio.tipoDocumento") instanceof HTMLInputElement
          ? (document.getElementById("inicio.tipoDocumento") as HTMLInputElement)
          : from instanceof HTMLInputElement
            ? from
            : null;

      if (hidden) {
        hidden.value = pair.value;
        hidden.dispatchEvent(new Event("input", { bubbles: true }));
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      }

      if (textBox) {
        textBox.value = pair.label;
        textBox.setAttribute("value", pair.label);
        textBox.dispatchEvent(new Event("input", { bubbles: true }));
        textBox.dispatchEvent(new Event("change", { bubbles: true }));
      }

      return {
        ok: true as const,
        code: pair.value,
        label: pair.label,
        updatedHidden: Boolean(hidden),
        updatedTextbox: Boolean(textBox),
      };
    }, aliasTargets)
    .catch(() => ({ ok: false as const, reason: "evaluate-error" }));

  if (!domFallback.ok) {
    throw new Error(
      `No pude elegir «${targetLabel}»: el menú Dojo no respondió y el respaldo DOM falló (${"reason" in domFallback ? domFallback.reason : "desconocido"}). Hace falta un <select> en la página con la opción o input hidden name=tipoDocumento.`,
    );
  }

  await onStep?.(
    `SUNAT: respaldo DOM: input#inicio.tipoDocumento → «${domFallback.label}»; hidden name=tipoDocumento → value="${domFallback.code}".`,
  );
}

/** Tras el modal de inconsistencia: abre el desplegable y elige SIN DOCUMENTO (control id inicio.tipoDocumento, suele ser un input Dojo). */
async function selectSunatInicioTipoDocumentoSinDocumento(page: Page, onStep?: StepReporter): Promise<void> {
  await selectSunatInicioTipoDocumentoByLabel(page, "Sin documento", onStep);
}

async function readSunatInicioTipoDocumentoState(
  page: Page,
): Promise<{ visibleLabel: string; hiddenCode: string }> {
  for (const scope of collectPageScopes(page)) {
    const result = await scope
      .locator("body")
      .evaluate(() => {
        const visibleInput = document.getElementById("inicio.tipoDocumento");
        const hiddenInput = document.querySelector('input[type="hidden"][name="tipoDocumento"]');

        const visibleLabel =
          visibleInput instanceof HTMLInputElement
            ? (visibleInput.value || "").trim()
            : ((visibleInput?.textContent || "") ?? "").replace(/\s+/g, " ").trim();
        const hiddenCode =
          hiddenInput instanceof HTMLInputElement ? (hiddenInput.value || "").trim() : "";

        return { visibleLabel, hiddenCode };
      })
      .catch(() => ({ visibleLabel: "", hiddenCode: "" }));

    if (result.visibleLabel || result.hiddenCode) {
      return result;
    }
  }

  return { visibleLabel: "", hiddenCode: "" };
}

function describePageScopeForLog(scope: PageScope): string {
  if ("url" in scope && typeof scope.url === "function") {
    try {
      const u = scope.url();
      return u ? `marco ${u}` : "marco (sin URL)";
    } catch {
      return "marco";
    }
  }
  return "página principal";
}

async function tryClickSunatModalAceptar(
  page: Page,
  dialogScope: PageScope,
  modalRoot: Locator | null,
  onStep?: StepReporter,
): Promise<boolean> {
  const tryLabel = async (label: string, locator: Locator): Promise<boolean> => {
    const target = locator.first();
    const visible = await target.isVisible().catch(() => false);
    await onStep?.(`SUNAT modal inconsistencia: ${label} → visible=${visible ? "sí" : "no"}`);
    if (!visible) {
      return false;
    }
    try {
      await target.click({ timeout: 8_000 });
      await onStep?.(`SUNAT modal inconsistencia: click hecho con ${label} (normal).`);
      return true;
    } catch (firstError) {
      const msg = firstError instanceof Error ? firstError.message : String(firstError);
      await onStep?.(`SUNAT modal inconsistencia: click normal falló (${msg}); pruebo force con ${label}.`);
      try {
        await target.click({ force: true, timeout: 5_000 });
        await onStep?.(`SUNAT modal inconsistencia: click force OK con ${label}.`);
        return true;
      } catch {
        await onStep?.(`SUNAT modal inconsistencia: click force también falló con ${label}.`);
        return false;
      }
    }
  };

  /** Botón Dojo: el nodo que suele recibir el clic es el `span` exterior con `widgetid`, no el inner `#dlgBtnAceptar`. */
  const dlgAceptarWidgetSelectors: { label: string; sel: string }[] = [
    { label: "span.dijitButton[widgetid=dlgBtnAceptar]", sel: 'span.dijitButton[widgetid="dlgBtnAceptar"]' },
    { label: "span[widgetid=dlgBtnAceptar]", sel: 'span[widgetid="dlgBtnAceptar"]' },
    { label: "[widgetid=dlgBtnAceptar]", sel: '[widgetid="dlgBtnAceptar"]' },
  ];

  const modalScoped: { label: string; locator: Locator }[] = [];
  if (modalRoot) {
    for (const { label, sel } of dlgAceptarWidgetSelectors) {
      modalScoped.push({
        label: `diálogo dijit raíz ${label}`,
        locator: modalRoot.locator(sel),
      });
    }
    modalScoped.push(
      { label: "dentro del diálogo #dlgBtnAceptar[role=button]", locator: modalRoot.locator("#dlgBtnAceptar[role='button']") },
      { label: "dentro del diálogo #dlgBtnAceptar", locator: modalRoot.locator("#dlgBtnAceptar") },
      { label: "dentro del diálogo #dlgBtnAceptar_label", locator: modalRoot.locator("#dlgBtnAceptar_label") },
      {
        label: 'dentro del diálogo span[widgetid=dlgBtnAceptar] [role=button]',
        locator: modalRoot.locator('span[widgetid="dlgBtnAceptar"] [role="button"]'),
      },
      {
        label: "dentro del diálogo getByRole(button, Aceptar)",
        locator: modalRoot.getByRole("button", { name: /^\s*Aceptar\s*$/i }),
      },
      {
        label: "dentro del diálogo .dijitButtonText Aceptar",
        locator: modalRoot.locator(".dijitButtonText").filter({ hasText: /^\s*Aceptar\s*$/i }),
      },
    );
  }

  for (const { label, locator } of modalScoped) {
    if (await tryLabel(label, locator)) {
      return true;
    }
  }

  await onStep?.(
    `SUNAT modal inconsistencia: busco widget dlgBtnAceptar en el marco del mensaje (${describePageScopeForLog(dialogScope)}).`,
  );

  for (const { label, sel } of dlgAceptarWidgetSelectors) {
    const widgetLoc = dialogScope.locator(sel);
    const nW = await widgetLoc.count().catch(() => 0);
    await onStep?.(`SUNAT modal inconsistencia: en marco → ${nW}× ${label}.`);
    for (let i = 0; i < nW; i += 1) {
      if (await tryLabel(`marco ${label} [${i}]`, widgetLoc.nth(i))) {
        return true;
      }
    }
  }

  await onStep?.(
    `SUNAT modal inconsistencia: busco #dlgBtnAceptar (nodo foco interior) en el mismo marco (${describePageScopeForLog(dialogScope)}).`,
  );

  const scopeWide = dialogScope.locator("#dlgBtnAceptar");
  const nScope = await scopeWide.count().catch(() => 0);
  await onStep?.(`SUNAT modal inconsistencia: en este marco hay ${nScope} nodo(s) #dlgBtnAceptar.`);

  for (let i = 0; i < nScope; i += 1) {
    const label = `#dlgBtnAceptar en marco [índice ${i}]`;
    if (await tryLabel(label, scopeWide.nth(i))) {
      return true;
    }
  }

  const scopeWideLabel = dialogScope.locator("#dlgBtnAceptar_label");
  const nLabel = await scopeWideLabel.count().catch(() => 0);
  await onStep?.(`SUNAT modal inconsistencia: en este marco hay ${nLabel} nodo(s) #dlgBtnAceptar_label.`);

  for (let i = 0; i < nLabel; i += 1) {
    const label = `#dlgBtnAceptar_label en marco [índice ${i}]`;
    if (await tryLabel(label, scopeWideLabel.nth(i))) {
      return true;
    }
  }

  await onStep?.("SUNAT modal inconsistencia: barro todos los marcos por widget dlgBtnAceptar y #dlgBtnAceptar.");
  for (const scope of collectPageScopes(page)) {
    const scopeTag = describePageScopeForLog(scope);
    for (const { label, sel } of dlgAceptarWidgetSelectors) {
      const wLoc = scope.locator(sel);
      const nw = await wLoc.count().catch(() => 0);
      if (nw === 0) {
        continue;
      }
      await onStep?.(`SUNAT modal inconsistencia: global ${scopeTag} → ${nw}× ${label}.`);
      for (let j = 0; j < nw; j += 1) {
        if (await tryLabel(`global ${scopeTag} ${label}[${j}]`, wLoc.nth(j))) {
          return true;
        }
      }
    }

    const loc = scope.locator("#dlgBtnAceptar");
    const n = await loc.count().catch(() => 0);
    if (n === 0) {
      continue;
    }
    await onStep?.(`SUNAT modal inconsistencia: marco ${scopeTag} → ${n} #dlgBtnAceptar (inner).`);
    for (let j = 0; j < n; j += 1) {
      if (await tryLabel(`#dlgBtnAceptar global ${scopeTag}[${j}]`, loc.nth(j))) {
        return true;
      }
    }
  }

  if (modalRoot) {
    const closeIcon = modalRoot.locator(".dijitDialogCloseIcon, [class*='DialogCloseIcon']").first();
    if (await tryLabel("icono cerrar .dijitDialogCloseIcon", closeIcon)) {
      return true;
    }
  }

  await onStep?.(
    "SUNAT modal inconsistencia: no se pudo hacer click en Aceptar ni en la X; el modal puede seguir abierto.",
  );
  return false;
}

async function tryRecoverSunatInconsistentIdentityModal(
  page: Page,
  profile: SiteProfile,
  draft: InvoiceDraft,
  onStep?: StepReporter,
): Promise<boolean> {
  if (!profile.sunat.customerDocumentTypeSelector) {
    return false;
  }

  let dialogHit: { scope: PageScope; modalRoot: Locator | null } | null = null;

  for (const scope of collectPageScopes(page)) {
    const messageLocator = scope.getByText(SUNAT_INCONSISTENT_IDENTITY_MODAL_RE);
    const messageCount = await messageLocator.count().catch(() => 0);
    let messageVisible = false;
    for (let m = 0; m < Math.min(messageCount, 12); m += 1) {
      if (await messageLocator.nth(m).isVisible().catch(() => false)) {
        messageVisible = true;
        await onStep?.(`SUNAT modal inconsistencia: nodo de mensaje visible en coincidencia [${m}] (${describePageScopeForLog(scope)}).`);
        break;
      }
    }
    if (!messageVisible) {
      continue;
    }

    let modalRoot: Locator | null = null;
    const dialogs = scope.locator(".dijitDialog").filter({ hasText: SUNAT_INCONSISTENT_IDENTITY_MODAL_RE });
    const dCount = await dialogs.count().catch(() => 0);

    for (let i = 0; i < Math.min(dCount, 12); i += 1) {
      const candidate = dialogs.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        modalRoot = candidate;
        await onStep?.(`SUNAT modal inconsistencia: usando .dijitDialog visible que contiene el mensaje (índice ${i}).`);
        break;
      }
    }

    if (!modalRoot) {
      const anyVisible = scope.locator(".dijitDialog:visible");
      const anyCount = await anyVisible.count().catch(() => 0);
      await onStep?.(
        `SUNAT modal inconsistencia: no hallé .dijitDialog filtrado por texto; hay ${anyCount} .dijitDialog:visible en este marco — busco Aceptar igual en el marco.`,
      );
    }

    dialogHit = { scope, modalRoot };
    break;
  }

  if (!dialogHit) {
    return false;
  }

  const rawDoc = (draft.customer.documentNumber || "").trim();
  await onStep?.(
    `SUNAT: detecté «documento de identidad inconsistente» para ${truncateForLog(rawDoc || "sin documento", 32)}; omitiré esta venta para no afectar el resto de la corrida.`,
  );
  throw new OmitSaleError(
    `SUNAT rechazó el DNI ${rawDoc || "sin número"} por inconsistencia. Se omite esta venta y la corrida continúa con las demás.`,
  );
}

async function prepareSunatCustomerWithoutDocument(
  page: Page,
  profile: SiteProfile,
  customerName: string,
  onStep?: StepReporter,
): Promise<{ scope: PageScope; locator: Locator }> {
  await selectSunatInicioTipoDocumentoSinDocumento(page, onStep);
  await page.waitForTimeout(SUNAT_TIMING.postWithoutDocumentSelectionPauseMs);

  const nameSelectorsRecovery = uniqueSelectors([
    "#inicio\\.razonSocial",
    "xpath=//*[@id='inicio.razonSocial']",
    ...customerNameSelectors(profile.sunat.customerNameSelector),
  ]);

  const nameField = await waitForAnyVisibleLocatorInPageTree(page, nameSelectorsRecovery, 15_000);

  const nameDeadline = Date.now() + 12_000;
  while (Date.now() < nameDeadline) {
    if (await nameField.locator.isEditable().catch(() => false)) {
      break;
    }
    await page.waitForTimeout(200);
  }

  if (await nameField.locator.isEditable().catch(() => false)) {
    await onStep?.("SUNAT: campo nombre habilitado; escribiré el nombre del cliente.");
    await nameField.locator.click().catch(() => undefined);
    await nameField.locator.fill(customerName);
    await nameField.locator.press("Tab").catch(() => undefined);
    return nameField;
  }

  await onStep?.("SUNAT: el campo nombre sigue bloqueado; aplicaré respaldo DOM para escribirlo igual.");
  await nameField.locator.evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("El campo de nombre no es un input.");
    }

    element.removeAttribute("disabled");
    element.removeAttribute("aria-disabled");
    element.disabled = false;
    element.value = value;
    element.setAttribute("value", value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }, customerName);

  return nameField;
}

function collectPageScopes(page: Page): PageScope[] {
  return [page, ...page.frames()];
}

async function isAnyVisibleLocatorInPageTree(
  page: Page,
  selectors: string[],
  preferredScope?: PageScope,
): Promise<boolean> {
  const scopes = preferredScope
    ? [preferredScope, ...collectPageScopes(page).filter((scope) => scope !== preferredScope)]
    : collectPageScopes(page);

  for (const scope of scopes) {
    for (const selector of selectors) {
      const locator = scope.locator(selector);
      const count = await locator.count().catch(() => 0);

      if (!count) {
        continue;
      }

      for (let index = 0; index < Math.min(count, 20); index += 1) {
        if (await locator.nth(index).isVisible().catch(() => false)) {
          return true;
        }
      }
    }
  }

  return false;
}

async function describeVisibleControlsInPageTree(page: Page): Promise<string> {
  const summaries: string[] = [];

  for (const scope of collectPageScopes(page)) {
    const url = "url" in scope ? scope.url() : "";
    const controls = await scope
      .locator("input, select, textarea, button")
      .evaluateAll((elements) =>
        elements
          .filter((element) => element instanceof HTMLElement)
          .filter(
            (element) =>
              Boolean(
                element.offsetWidth || element.offsetHeight || element.getClientRects().length,
              ),
          )
          .slice(0, 12)
          .map((element) => {
            const htmlElement = element;
            return {
              tag: htmlElement.tagName.toLowerCase(),
              id: htmlElement.id || "",
              name: htmlElement.getAttribute("name") || "",
              type: htmlElement.getAttribute("type") || "",
              value: htmlElement.getAttribute("value") || "",
              text: (htmlElement.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
              title: htmlElement.getAttribute("title") || "",
            };
          }),
      )
      .catch(() => []);

    if (controls.length) {
      summaries.push(`${url || "about:blank"} => ${JSON.stringify(controls)}`);
    }
  }

  return summaries.join(" || ") || "sin controles visibles";
}

async function readLocatorValue(locator: Locator): Promise<string> {
  const inputValue = await locator.inputValue().catch(() => "");
  if (inputValue.trim()) {
    return inputValue.trim();
  }

  const attributeValue = await locator.getAttribute("value").catch(() => "");
  if (attributeValue?.trim()) {
    return attributeValue.trim();
  }

  const text = await locator.textContent().catch(() => "");
  if (text?.trim()) {
    return text.trim();
  }

  const innerText = await locator.evaluate((element) => (element as HTMLElement).innerText || "").catch(() => "");
  return innerText.trim();
}

async function describeLocatorIdentity(locator: Locator): Promise<string> {
  return locator
    .evaluate((element) => {
      const htmlElement = element as HTMLElement;
      const tag = htmlElement.tagName.toLowerCase();
      const id = htmlElement.id ? `#${htmlElement.id}` : "";
      const name = htmlElement.getAttribute("name");
      return `${tag}${id}${name ? `[name=${name}]` : ""}`;
    })
    .catch(() => "campo-desconocido");
}

async function waitForSunatProcessingToSettle(
  page: Page,
  label: string,
  onStep?: StepReporter,
  timeoutMs = 20_000,
): Promise<void> {
  const processingVisible = await waitForSunatProcessingToAppear(
    page,
    SUNAT_TIMING.processingMarkerAppearTimeoutMs,
  );

  if (!processingVisible) {
    return;
  }

  await onStep?.(`SUNAT está procesando ${label}; esperaré con más calma.`);
  const deadline = Date.now() + timeoutMs;
  let nextProgressLogAt = Date.now() + SUNAT_TIMING.processingProgressLogMs;

  while (Date.now() < deadline) {
    const stillProcessing = await isAnyVisibleLocatorInPageTree(page, sunatProcessingMarkers());
    if (!stillProcessing) {
      await onStep?.(`SUNAT terminó de procesar ${label}.`);
      return;
    }

    if (Date.now() >= nextProgressLogAt) {
      await onStep?.(`SUNAT sigue procesando ${label}; continúo esperando.`);
      nextProgressLogAt = Date.now() + SUNAT_TIMING.processingProgressLogMs;
    }

    await page.waitForTimeout(SUNAT_TIMING.processingPollMs);
  }

  await onStep?.(
    `SUNAT sigue procesando ${label} después de ${Math.round(timeoutMs / 1_000)}s; revisaré si la pantalla cambió igual.`,
  );
}

async function waitForSunatProcessingToAppear(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isAnyVisibleLocatorInPageTree(page, sunatProcessingMarkers())) {
      return true;
    }

    await page.waitForTimeout(SUNAT_TIMING.processingMarkerAppearPollMs);
  }

  return false;
}

async function clickSunatAction(
  page: Page,
  locator: Locator,
  onStep: StepReporter | undefined,
  label: string,
  options?: {
    skipGenericDialogDismiss?: boolean;
  },
): Promise<void> {
  await dismissSunatContactValidationSurface(page, onStep);
  if (!options?.skipGenericDialogDismiss) {
    await tryDismissGenericSunatDialog(page, onStep);
  }
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);

  try {
    await locator.click({ timeout: 8_000 });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const blockedByOverlay =
      /intercepts pointer events|dijitDialogUnderlay|dlgMensaje_underlay|divModalCampana|ifrVCE/i.test(message);
    if (!blockedByOverlay) {
      throw error;
    }

    await onStep?.(`SUNAT: un overlay bloqueó el click en ${label}; intentaré limpiarlo y reintentar.`);
    await dismissSunatContactValidationSurface(page, onStep);
    if (!options?.skipGenericDialogDismiss) {
      await tryDismissGenericSunatDialog(page, onStep);
    }
    await locator.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ timeout: 8_000 }).catch(async () => {
      await locator.click({ force: true, timeout: 8_000 });
    });
  }
}

async function tryDismissGenericSunatDialog(page: Page, onStep?: StepReporter): Promise<void> {
  const overlayVisible = await isAnyVisibleLocatorInPageTree(page, [
    "#dlgMensaje_underlay",
    ".dijitDialogUnderlay",
    ".dijitDialogUnderlayWrapper",
  ]).catch(() => false);

  if (!overlayVisible) {
    return;
  }

  const acceptSelectors = [
    "#dlgBtnAceptarConfirm_label",
    "#dlgBtnAceptar_label",
    "#dlgBtnAceptar",
    "xpath=//span[contains(@class,'dijitButtonText') and contains(normalize-space(.), 'Aceptar')]",
    "xpath=//button[contains(normalize-space(.), 'Aceptar')]",
    "xpath=//input[contains(@value, 'Aceptar')]",
  ];

  const acceptButton = await tryWaitForAnyVisibleLocatorInPageTree(page, acceptSelectors, 750);
  if (!acceptButton) {
    return;
  }

  await onStep?.("SUNAT: encontré un diálogo bloqueante; haré click en Aceptar para liberar el flujo.");
  await acceptButton.locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await acceptButton.locator.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(200).catch(() => undefined);
}

function truncateForLog(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

async function readSunatReceiptInfo(
  page: Page,
  profile: SiteProfile,
): Promise<{ receiptNumber: string; receiptPrefix: string }> {
  const selector = profile.sunat.receiptNumberSelector;
  const candidates: string[] = [];

  if (selector) {
    const locator = await tryWaitForVisibleLocatorInPageTree(page, selector, 5_000);
    if (locator) {
      candidates.push(await readLocatorValue(locator.locator));
    }
  }

  const bodyText = (await page.locator("body").textContent().catch(() => "")) ?? "";
  candidates.push(bodyText);

  for (const candidate of candidates) {
    const receiptNumber = extractSunatReceiptNumber(candidate);
    if (!receiptNumber) {
      continue;
    }

    const receiptPrefix = extractSunatReceiptPrefix(receiptNumber);
    if (!receiptPrefix) {
      break;
    }

    return {
      receiptNumber,
      receiptPrefix,
    };
  }

  throw new Error("SUNAT mostró la pantalla final, pero no pude leer el número del comprobante emitido.");
}

function extractSunatReceiptNumber(rawValue: string): string | undefined {
  return rawValue.match(/[A-Z]{1,4}\d{0,2}-\d+/i)?.[0]?.toUpperCase();
}

async function downloadSunatReceiptFiles(
  page: Page,
  profile: SiteProfile,
  config: AppConfig,
  params: {
    saleExternalId: string;
    customerDocumentNumber: string;
    receiptPrefix: string;
    boletasDownloadDir?: string;
  },
  onStep?: StepReporter,
): Promise<string[]> {
  const downloadsDir =
    params.boletasDownloadDir ?? path.join(config.dataPaths.rootDir, "boletas-descargadas");
  fs.mkdirSync(downloadsDir, { recursive: true });

  const baseName = `${params.saleExternalId}_${params.receiptPrefix}-${params.customerDocumentNumber}`;
  const downloadedFiles: string[] = [];
  const pdfSelector = profile.sunat.pdfDownloadSelector;

  if (!pdfSelector) {
    throw new Error("Falta el selector configurado para descargar el PDF de SUNAT.");
  }

  await onStep?.("Buscando el botón Descargar PDF.");
  const pdfButton = await waitForVisibleLocatorInPageTree(page, pdfSelector, 15_000);
  await onStep?.(`Botón Descargar PDF encontrado (${await describeLocatorIdentity(pdfButton.locator)}).`);
  await onStep?.("Descarga del PDF iniciada.");

  const pdfTargetPath = path.join(downloadsDir, `${baseName}.pdf`);
  const pdfDownload = await waitForSunatDownload(page, pdfButton.locator);
  if (!pdfDownload) {
    throw new Error("SUNAT no inició la descarga del PDF de la boleta.");
  }
  await pdfDownload.saveAs(pdfTargetPath);
  downloadedFiles.push(pdfTargetPath);
  await onStep?.(`PDF guardado en ${pdfTargetPath}.`);

  if (profile.sunat.xmlDownloadSelector) {
    const xmlTargetPath = path.join(downloadsDir, `${baseName}.xml`);
    const xmlPath = await triggerSunatDownload(page, profile.sunat.xmlDownloadSelector, xmlTargetPath);
    if (xmlPath) {
      downloadedFiles.push(xmlPath);
    }
  }

  return downloadedFiles;
}

async function closeSunatSuccessSurface(
  page: Page,
  profile: SiteProfile,
  onStep?: StepReporter,
): Promise<boolean> {
  const closeSelectors = uniqueSelectors([
    profile.sunat.closeSuccessSelector ?? "",
    "xpath=//input[contains(@value,'Cerrar')]",
    "xpath=//button[contains(normalize-space(.),'Cerrar')]",
    "text=Cerrar",
  ]);

  const closeButton = await tryWaitForAnyVisibleLocatorInPageTree(page, closeSelectors, 5_000);
  if (!closeButton) {
    await onStep?.("SUNAT: no encontré el botón Cerrar en la pantalla final; abriré una pestaña nueva en la siguiente venta.");
    return false;
  }

  await onStep?.(`SUNAT: boleta descargada; haré click en Cerrar (${await describeLocatorIdentity(closeButton.locator)}).`);
  await clickSunatAction(page, closeButton.locator, onStep, "Cerrar boleta emitida");
  await waitForSunatProcessingToSettle(page, "el cierre de la boleta emitida", onStep, 8_000).catch(() => undefined);
  const acceptedRepeatBoleta = await waitForSunatRepeatBoletaDialogAndAccept(page, profile, onStep, 15_000);
  if (acceptedRepeatBoleta) {
    await waitForSunatProcessingToSettle(
      page,
      "la confirmación para emitir otra boleta",
      onStep,
      8_000,
    ).catch(() => undefined);
  } else {
    await onStep?.(
      "SUNAT: no pude resolver el diálogo Aceptar tras Cerrar; verificaré igual si el formulario quedó listo para reutilizarse.",
    );
  }

  const resumedWorkflow = await tryWaitForAnyVisibleLocatorInPageTree(
    page,
    [
      ...customerDocumentSelectors(profile.sunat.customerDocumentSelector),
      ...customerNameSelectors(profile.sunat.customerNameSelector),
      ...customerContinueSelectors(profile.sunat.customerContinueSelector ?? "text=Continuar"),
      ...addItemButtonSelectors(profile.sunat.addItemButtonSelector),
    ].filter(Boolean),
    15_000,
  );

  if (!resumedWorkflow) {
    await onStep?.("SUNAT: hice click en Cerrar, pero no confirmé la vuelta al formulario; en la siguiente venta abriré una pestaña nueva.");
    return false;
  }

  await onStep?.(`SUNAT: la pantalla quedó lista para reutilizarse (${await describeLocatorIdentity(resumedWorkflow.locator)}).`);
  return true;
}

async function tryClickSunatRepeatBoletaAcceptFromDialog(
  page: Page,
  onStep?: StepReporter,
): Promise<boolean> {
  const dialogTextLooksLikeRepeatPrompt = (raw: string): boolean => {
    const normalized = raw
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    return (
      normalized.includes("desea emitir otra boleta de venta") ||
      normalized.includes("debe haber otorgado la boleta de venta") ||
      normalized.includes("confirmar")
    );
  };

  for (const scope of collectPageScopes(page)) {
    const dialogs = scope.locator(".dijitDialog");
    const dialogCount = await dialogs.count().catch(() => 0);

    for (let dialogIndex = 0; dialogIndex < Math.min(dialogCount, 10); dialogIndex += 1) {
      const dialog = dialogs.nth(dialogIndex);
      if (!(await dialog.isVisible().catch(() => false))) {
        continue;
      }

      const dialogText = ((await dialog.textContent().catch(() => "")) ?? "").trim();
      if (!dialogTextLooksLikeRepeatPrompt(dialogText)) {
        continue;
      }

      const acceptCandidates = [
        "#dlgBtnAceptarConfirm_label",
        "#dlgBtnAceptarConfirm",
        "#dlgBtnAceptar_label",
        "#dlgBtnAceptar",
        ".dijitButtonText",
        "button",
        "input[type='button']",
        "input[type='submit']",
        "[role='button']",
      ];

      for (const selector of acceptCandidates) {
        const candidates = dialog.locator(selector);
        const count = await candidates.count().catch(() => 0);

        for (let index = 0; index < Math.min(count, 20); index += 1) {
          const candidate = candidates.nth(index);
          if (!(await candidate.isVisible().catch(() => false))) {
            continue;
          }

          const text = (((await candidate.textContent().catch(() => "")) ?? "") || "").replace(/\s+/g, " ").trim();
          const value = ((await candidate.getAttribute("value").catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
          const joined = `${text} ${value}`.trim().toLowerCase();
          if (!joined.includes("aceptar")) {
            continue;
          }

          try {
            await candidate.scrollIntoViewIfNeeded().catch(() => undefined);
            await candidate.click({ timeout: 2_000 }).catch(async () => {
              await candidate.click({ force: true, timeout: 2_000 });
            });
            await onStep?.("SUNAT: hice click en Aceptar dentro del diálogo de Confirmar.");
            await page.waitForTimeout(250).catch(() => undefined);
            return true;
          } catch {
            const clickedViaDom = await candidate
              .evaluate((element) => {
                const target =
                  element.closest("button, a, [role='button'], .dijitButton, .dijitButtonNode") ?? element;
                if (!(target instanceof HTMLElement)) {
                  return false;
                }
                target.click();
                target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                return true;
              })
              .catch(() => false);

            if (clickedViaDom) {
              await onStep?.("SUNAT: hice click DOM en Aceptar dentro del diálogo de Confirmar.");
              await page.waitForTimeout(250).catch(() => undefined);
              return true;
            }
          }
        }
      }
    }
  }

  const pressedEnter = await page.keyboard
    .press("Enter")
    .then(() => true)
    .catch(() => false);

  if (pressedEnter) {
    await onStep?.("SUNAT: no pude clicar Aceptar por selector/DOM; envié Enter para confirmar el diálogo.");
    await page.waitForTimeout(250).catch(() => undefined);
    return true;
  }

  return false;
}

async function waitForSunatRepeatBoletaDialogAndAccept(
  page: Page,
  profile: SiteProfile,
  onStep?: StepReporter,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let dialogSeen = false;
  let attemptedImmediateKeyboardConfirm = false;

  while (Date.now() < deadline) {
    if (!attemptedImmediateKeyboardConfirm) {
      attemptedImmediateKeyboardConfirm = true;
      const enterConfirmed = await page.keyboard
        .press("Enter")
        .then(() => true)
        .catch(() => false);
      if (enterConfirmed) {
        await onStep?.(
          "SUNAT: tras Cerrar, probé confirmar de inmediato con Enter por si el foco ya estaba en Aceptar.",
        );
        await page.waitForTimeout(500).catch(() => undefined);
        const resumedAfterEnter = await tryWaitForAnyVisibleLocatorInPageTree(
          page,
          [
            ...customerDocumentSelectors(profile.sunat.customerDocumentSelector),
            ...customerNameSelectors(profile.sunat.customerNameSelector),
            ...customerContinueSelectors(profile.sunat.customerContinueSelector ?? "text=Continuar"),
            ...addItemButtonSelectors(profile.sunat.addItemButtonSelector),
          ].filter(Boolean),
          2_000,
        );
        if (resumedAfterEnter) {
          await onStep?.(
            `SUNAT: el formulario volvió tras Enter (${await describeLocatorIdentity(resumedAfterEnter.locator)}).`,
          );
          return true;
        }
      }
    }

    const dialog = await tryWaitForAnyVisibleLocatorInPageTree(
      page,
      [
        "text=Desea emitir otra Boleta de Venta",
        "text=Debe haber otorgado la Boleta de Venta",
        "text=Confirmar",
      ],
      500,
    );

    if (dialog && !dialogSeen) {
      dialogSeen = true;
      await onStep?.(
        `SUNAT: apareció el diálogo posterior a Cerrar (${await describeLocatorIdentity(dialog.locator)}); intentaré confirmar con Aceptar.`,
      );
      const enterConfirmed = await page.keyboard
        .press("Enter")
        .then(() => true)
        .catch(() => false);
      if (enterConfirmed) {
        await onStep?.("SUNAT: el diálogo ya estaba visible; envié Enter para confirmar Aceptar.");
        await page.waitForTimeout(500).catch(() => undefined);
      }
    }

    const acceptButton = await tryWaitForAnyVisibleLocatorInPageTree(
      page,
      confirmAcceptSelectors(profile.sunat.confirmAcceptSelector),
      500,
    );
    if (acceptButton) {
      await onStep?.(
        `SUNAT: apareció la confirmación para emitir otra boleta (${await describeLocatorIdentity(acceptButton.locator)}); haré click en Aceptar.`,
      );
      try {
        await clickSunatAction(page, acceptButton.locator, onStep, "Aceptar tras cerrar boleta", {
          skipGenericDialogDismiss: true,
        });
        return true;
      } catch (error) {
        await onStep?.(
          `SUNAT: falló el click Playwright en Aceptar tras Cerrar (${error instanceof Error ? error.message : String(error)}); probaré un click directo dentro del diálogo.`,
        );
      }
    }

    if (await tryClickSunatRepeatBoletaAcceptFromDialog(page, onStep)) {
      return true;
    }

    await page.waitForTimeout(250).catch(() => undefined);
  }

  return false;
}

export function extractSunatReceiptPrefix(receiptNumber?: string): string | undefined {
  const token = receiptNumber?.split("-")[0]?.trim();
  const normalized = token?.match(/[A-Z]{1,4}\d{0,2}/i)?.[0];
  return normalized?.toUpperCase();
}

async function triggerSunatDownload(
  page: Page,
  selector: string,
  targetPath: string,
): Promise<string | undefined> {
  const button = await tryWaitForVisibleLocatorInPageTree(page, selector, 10_000);
  if (!button) {
    return undefined;
  }

  const download = await waitForSunatDownload(page, button.locator);
  if (!download) {
    return undefined;
  }

  await download.saveAs(targetPath);
  return targetPath;
}

async function waitForSunatDownload(page: Page, locator: Locator): Promise<Download | undefined> {
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20_000 }),
      locator.click(),
    ]);
    return download;
  } catch {
    return undefined;
  }
}

function normalizeComparableText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function customerDocumentSelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#boleta\\.numeroDocumento",
    "xpath=//*[@id='boleta.numeroDocumento']",
    "xpath=//*[@id='inicio.numeroDocumento']",
    "xpath=//td[contains(normalize-space(.), 'Consigne el Número del Documento del Cliente')]/following-sibling::td//input[not(@type='hidden')][1]",
    "xpath=//td[contains(normalize-space(.), 'Consigne el Numero del Documento del Cliente')]/following-sibling::td//input[not(@type='hidden')][1]",
    "xpath=//td[contains(normalize-space(.), 'Número de documento')]/following-sibling::td//input[1]",
    "xpath=//td[contains(normalize-space(.), 'Numero de documento')]/following-sibling::td//input[1]",
    "xpath=//label[contains(normalize-space(.), 'Número de documento')]/following::input[1]",
    "xpath=//label[contains(normalize-space(.), 'Numero de documento')]/following::input[1]",
    "xpath=//*[contains(normalize-space(.), 'Número del Documento del Cliente')]/following::input[1]",
    "xpath=//*[contains(normalize-space(.), 'Numero del Documento del Cliente')]/following::input[1]",
  ]);
}

export function customerNameSelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#boleta\\.razonSocial",
    "xpath=//*[@id='boleta.razonSocial']",
    "xpath=//*[@id='inicio.razonSocial']",
    "xpath=//td[contains(normalize-space(.), 'Consigne Apellidos y Nombres del Cliente')]/following-sibling::td//input[not(@type='hidden')][1]",
    "xpath=//td[contains(normalize-space(.), 'Consigne Apellidos y Nombres del Cliente, o Denominación o Razón Social')]/following-sibling::td//input[not(@type='hidden')][1]",
    "xpath=//td[contains(normalize-space(.), 'Consigne Apellidos y Nombres del Cliente, o Denominacion o Razon Social')]/following-sibling::td//input[not(@type='hidden')][1]",
    "xpath=//td[contains(normalize-space(.), 'Nombre del Cliente')]/following-sibling::td//input[1]",
    "xpath=//label[contains(normalize-space(.), 'Nombre del Cliente')]/following::input[1]",
    "xpath=//*[contains(normalize-space(.), 'Nombre del Cliente')]/following::input[1]",
  ]);
}

function customerDocumentTypeSelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#inicio\\.tipoDocumento",
    "xpath=//*[@id='inicio.tipoDocumento']",
    "xpath=//*[@id='widget_inicio.tipoDocumento']",
    "xpath=//td[contains(normalize-space(.), 'Seleccione el Tipo de documento y número de documento del Cliente')]/following-sibling::td//select[1]",
    "xpath=//td[contains(normalize-space(.), 'Seleccione el Tipo de documento y numero de documento del Cliente')]/following-sibling::td//select[1]",
  ]);
}

export function customerContinueSelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#boleta\\.botonGrabarDocumento_label",
    "xpath=//*[@id='boleta.botonGrabarDocumento_label']",
    "xpath=//*[@id='boleta.botonGrabarDocumento_label']/ancestor::*[@id='boleta.botonGrabarDocumento'][1]",
    "#boleta\\.botonGrabarDocumento",
    "xpath=//*[@id='boleta.botonGrabarDocumento']",
    "text=Continuar",
    "xpath=//*[contains(concat(' ', normalize-space(@class), ' '), ' dijitButtonText ') and contains(normalize-space(.), 'Continuar')]",
    "xpath=//*[@role='button' and contains(normalize-space(.), 'Continuar')]",
    "#inicio\\.botonGrabarDocumento",
    "xpath=//*[@id='inicio.botonGrabarDocumento']",
    "xpath=//input[@type='button' and contains(@value, 'Continuar')]",
    "xpath=//input[contains(@value, 'Continuar')]",
    "xpath=//button[contains(normalize-space(.), 'Continuar')]",
    "xpath=//input[@type='submit' and contains(@value, 'Continuar')]",
  ]);
}

async function continueSunatBoletaWizard(
  page: Page,
  profile: SiteProfile,
  onStep?: StepReporter,
  options?: {
    allowImmediateFinalStage?: boolean;
  },
): Promise<void> {
  if (options?.allowImmediateFinalStage) {
    const finalReady = await tryWaitForAnyVisibleLocatorInPageTree(
      page,
      [
        ...preliminarySunatStepMarkers(),
        ...finalSubmitSelectors(profile.sunat.finalSubmitSelector),
      ],
      2_000,
    );
    if (finalReady) {
      await onStep?.(
        `SUNAT ya está en la etapa final (${await describeLocatorIdentity(finalReady.locator)}); no buscaré otro Continuar.`,
      );
      return;
    }
  }

  await onStep?.("Buscando el botón Continuar de la boleta.");
  const continueSelectors = customerContinueSelectors(profile.sunat.customerContinueSelector ?? "text=Continuar");
  const firstContinue = await tryWaitForBottomMostVisibleLocatorInPageTree(page, continueSelectors, 15_000);
  if (!firstContinue) {
    await onStep?.("No encontré Continuar; esperaré si SUNAT cambia de pantalla por su cuenta.");
    await waitForAnyVisibleLocatorInPageTree(
      page,
      [...preliminarySunatStepMarkers(), profile.sunat.finalSubmitSelector ?? ""].filter(Boolean),
      20_000,
    );
    return;
  }
  await onStep?.("Encontré Continuar y voy a hacer click.");
  await firstContinue.locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await firstContinue.locator.click();
  await waitForSunatProcessingToSettle(page, "el primer Continuar", onStep, 15_000);

  const optionalMarker = await tryWaitForAnyVisibleLocatorInPageTree(
    page,
    optionalSunatStepMarkers(),
    3_000,
  );

  if (!optionalMarker) {
    await resolveAdditionalSunatTransportStep(page, profile, onStep);
    await ensureSunatAdvancedPastCustomerScreen(page, profile, onStep, "el primer Continuar");
    return;
  }

  const secondContinue = await waitForBottomMostVisibleLocatorInPageTree(page, continueSelectors, 10_000);
  await onStep?.("SUNAT mostró una pantalla opcional; hago click en Continuar otra vez.");
  await secondContinue.locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await secondContinue.locator.click();
  await waitForSunatProcessingToSettle(page, "la pantalla opcional", onStep, 30_000);

  await onStep?.("Verificando si SUNAT ya avanzó desde la pantalla opcional.");
  await waitForAnyVisibleLocatorInPageTree(
    page,
    [
      ...preliminarySunatStepMarkers(),
      ...finalSubmitSelectors(profile.sunat.finalSubmitSelector),
      ...additionalSunatTransportStepMarkers(),
    ].filter(Boolean),
    25_000,
  );

  await resolveAdditionalSunatTransportStep(page, profile, onStep);
  await ensureSunatAdvancedPastCustomerScreen(page, profile, onStep, "la pantalla opcional");
}

async function ensureSunatAdvancedPastCustomerScreen(
  page: Page,
  profile: SiteProfile,
  onStep?: StepReporter,
  contextLabel = "Continuar",
): Promise<void> {
  const targetSelectors = [
    ...preliminarySunatStepMarkers(),
    ...finalSubmitSelectors(profile.sunat.finalSubmitSelector),
    ...additionalSunatTransportStepMarkers(),
  ].filter(Boolean);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const targetSurface = await tryWaitForAnyVisibleLocatorInPageTree(page, targetSelectors, 8_000);
    if (targetSurface) {
      await onStep?.(
        `SUNAT avanzó después de ${contextLabel} (${await describeLocatorIdentity(targetSurface.locator)}).`,
      );
      return;
    }

    const stillOnCustomer = await isSunatCustomerQuestionnaireSurface(page, profile);
    if (!stillOnCustomer) {
      break;
    }

    if (attempt === 2) {
      break;
    }

    await onStep?.(
      `SUNAT siguió en la pantalla inicial del cliente tras ${contextLabel}; haré un Continuar adicional para retomar el flujo.`,
    );
    const continueButton = await tryWaitForBottomMostVisibleLocatorInPageTree(
      page,
      customerContinueSelectors(profile.sunat.customerContinueSelector ?? "text=Continuar"),
      5_000,
    );
    if (!continueButton) {
      break;
    }

    await clickSunatAction(page, continueButton.locator, onStep, `Continuar extra tras ${contextLabel}`);
    await waitForSunatProcessingToSettle(page, `${contextLabel} (reintento)`, onStep, 20_000);
    await dismissSunatContactValidationSurface(page, onStep);
  }

  await waitForAnyVisibleLocatorInPageTree(page, targetSelectors, 5_000);
}

async function isSunatCustomerQuestionnaireSurface(page: Page, profile: SiteProfile): Promise<boolean> {
  const hasContinue = await isAnyVisibleLocatorInPageTree(
    page,
    customerContinueSelectors(profile.sunat.customerContinueSelector ?? "text=Continuar"),
  ).catch(() => false);
  if (!hasContinue) {
    return false;
  }

  const hasCustomerFields = await isAnyVisibleLocatorInPageTree(
    page,
    [
      ...customerDocumentTypeSelectors(profile.sunat.customerDocumentTypeSelector ?? "#inicio\\.tipoDocumento"),
      ...customerDocumentSelectors(profile.sunat.customerDocumentSelector),
      ...customerNameSelectors(profile.sunat.customerNameSelector),
    ].filter(Boolean),
  ).catch(() => false);

  return hasCustomerFields;
}

function optionalSunatStepMarkers(): string[] {
  return uniqueSelectors([
    "text=Esta pantalla es opcional",
    "text=Consigne las observaciones de la Boleta de Venta",
    "text=Consigne Información Relacionada a la Boleta de Venta",
    "text=Informacion Relacionada",
  ]);
}

async function resolveAdditionalSunatTransportStep(
  page: Page,
  profile: SiteProfile,
  onStep?: StepReporter,
): Promise<void> {
  const transportMarker = await tryWaitForAnyVisibleLocatorInPageTree(
    page,
    additionalSunatTransportStepMarkers(),
    2_000,
  );

  if (!transportMarker) {
    return;
  }

  await onStep?.(
    "SUNAT abrió la pantalla adicional de traslado / información complementaria.",
  );

  const transportAcceptButton = await tryWaitForVisibleLocatorInPageTree(
    page,
    "#trasladoBienes\\.botonAceptar",
    5_000,
  );

  if (!transportAcceptButton) {
    throw new Error(
      "SUNAT abrió la pantalla adicional de traslado, pero no pude encontrar el botón Aceptar para continuar.",
    );
  }

  await onStep?.(
    `Intentaré aceptar la pantalla adicional (${await describeLocatorIdentity(
      transportAcceptButton.locator,
    )}) con los valores actuales.`,
  );
  await transportAcceptButton.locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await transportAcceptButton.locator.click().catch(() => undefined);

  const nextMarker = await tryWaitForAnyVisibleLocatorInPageTree(
    page,
    [
      ...preliminarySunatStepMarkers(),
      profile.sunat.finalSubmitSelector ?? "",
      ...additionalSunatTransportStepMarkers(),
    ].filter(Boolean),
    10_000,
  );

  if (!nextMarker) {
    throw new Error(
      "SUNAT abrió la pantalla adicional de traslado y no avanzó después de intentar Aceptar.",
    );
  }

  const isStillTransportStep = await tryWaitForAnyVisibleLocatorInPageTree(
    page,
    additionalSunatTransportStepMarkers(),
    1_000,
  );
  if (isStillTransportStep) {
    throw new Error(
      "SUNAT abrió la pantalla adicional de traslado y siguió visible después de Aceptar. Faltan datos de traslado o direcciones para continuar.",
    );
  }

  await onStep?.("La pantalla adicional de traslado ya no está visible; continúo con la preliminar.");
}

function additionalSunatTransportStepMarkers(): string[] {
  return uniqueSelectors([
    "text=Información Adicional de la Boleta de Venta Electrónica",
    "text=Informacion Adicional de la Boleta de Venta Electronica",
    "text=Información para sustento del traslado sin Guía de Remisión",
    "text=Informacion para sustento del traslado sin Guia de Remision",
    "#trasladoBienes\\.botonAceptar",
  ]);
}

function sunatProcessingMarkers(): string[] {
  return uniqueSelectors([
    "#waitMessage",
    "text=Procesando...",
    "text=Procesando",
  ]);
}

function preliminarySunatStepMarkers(): string[] {
  return uniqueSelectors([
    "text=PRELIMINAR DE BOLETA DE VENTA ELECTRÓNICA",
    "text=PRELIMINAR DE BOLETA DE VENTA ELECTRONICA",
  ]);
}

function finalSubmitSelectors(primarySelector?: string): string[] {
  return uniqueSelectors([
    primarySelector ?? "",
    "#boleta-preliminar\\.botonGrabarDocumento",
    "#boleta-preliminar\\.botonGrabarDocumento_label",
    "xpath=//*[@id='boleta-preliminar.botonGrabarDocumento_label']",
    "xpath=//*[@id='boleta-preliminar.botonGrabarDocumento_label']/ancestor::*[@id='boleta-preliminar.botonGrabarDocumento'][1]",
    "xpath=//*[@id='boleta-preliminar.botonGrabarDocumento']",
  ]);
}

function confirmAcceptSelectors(primarySelector?: string): string[] {
  return uniqueSelectors([
    primarySelector ?? "",
    "#dlgBtnAceptarConfirm_label",
    "#dlgBtnAceptarConfirm",
    "#dlgBtnAceptar_label",
    "#dlgBtnAceptar",
    "text=Aceptar",
    "xpath=//div[contains(@class,'dijitDialog')][.//*[contains(normalize-space(.), 'Desea emitir otra Boleta de Venta')]]//*[self::span or self::button or self::input][contains(normalize-space(.), 'Aceptar') or contains(@value, 'Aceptar')]",
    "xpath=//div[contains(@class,'dijitDialog')][.//*[contains(normalize-space(.), 'Debe haber otorgado la Boleta de Venta')]]//*[self::span or self::button or self::input][contains(normalize-space(.), 'Aceptar') or contains(@value, 'Aceptar')]",
    "xpath=//span[contains(@class,'dijitButtonText') and contains(normalize-space(.), 'Aceptar')]",
    "xpath=//button[contains(normalize-space(.), 'Aceptar')]",
    "xpath=//input[contains(@value, 'Aceptar')]",
  ]);
}

function sunatFinalSurfaceSelectors(profile: SiteProfile): string[] {
  return uniqueSelectors([
    profile.sunat.successSelector ?? "",
    profile.sunat.receiptNumberSelector ?? "",
    profile.sunat.pdfDownloadSelector ?? "",
    profile.sunat.xmlDownloadSelector ?? "",
    "#numeroComprobante",
    "#dijit_form_Button_2_label",
  ]);
}

async function resolveSunatPostEmitTransition(
  page: Page,
  profile: SiteProfile,
  onStep?: StepReporter,
): Promise<void> {
  const startedAt = Date.now();
  let resumedUnexpectedSurface = false;

  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  while (Date.now() - startedAt < 15_000) {
    const successSurface = await tryWaitForAnyVisibleLocatorInPageTree(
      page,
      sunatFinalSurfaceSelectors(profile),
      750,
    );
    if (successSurface) {
      await onStep?.(`SUNAT ya mostró la pantalla final (${await describeLocatorIdentity(successSurface.locator)}).`);
      return;
    }

    const confirmButton = await tryWaitForAnyVisibleLocatorInPageTree(
      page,
      confirmAcceptSelectors(profile.sunat.confirmAcceptSelector),
      750,
    );
    if (confirmButton) {
      await onStep?.(`Botón Aceptar encontrado (${await describeLocatorIdentity(confirmButton.locator)}); haré click.`);
      await clickSunatAction(page, confirmButton.locator, onStep, "Aceptar confirmación", {
        skipGenericDialogDismiss: true,
      });
      await onStep?.("Click en Aceptar realizado; esperando el comprobante emitido.");
      await waitForSunatProcessingToSettle(page, "la confirmación de emisión", onStep, 8_000);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      continue;
    }

    if (!resumedUnexpectedSurface) {
      const backOnQuestionnaire =
        (await isAnyVisibleLocatorInPageTree(page, customerContinueSelectors(profile.sunat.customerContinueSelector ?? "text=Continuar")).catch(() => false)) &&
        (await isAnyVisibleLocatorInPageTree(page, [
          profile.sunat.customerDocumentTypeSelector ?? "",
          profile.sunat.customerDocumentSelector ?? "",
          profile.sunat.customerNameSelector ?? "",
        ].filter(Boolean)).catch(() => false));

      if (backOnQuestionnaire) {
        resumedUnexpectedSurface = true;
        await onStep?.("SUNAT volvió a una pantalla intermedia tras Emitir; intentaré retomar el flujo una sola vez.");
        await continueSunatBoletaWizard(page, profile, onStep);
        const submitButton = await waitForAnyVisibleLocatorInPageTree(
          page,
          finalSubmitSelectors(profile.sunat.finalSubmitSelector),
          15_000,
        );
        await onStep?.(`Retomé la etapa final y encontré Emitir (${await describeLocatorIdentity(submitButton.locator)}).`);
        await clickSunatAction(page, submitButton.locator, onStep, "Emitir tras retomar flujo");
        await waitForSunatProcessingToSettle(page, "la emisión reintentada", onStep, 20_000);
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        continue;
      }
    }

    await page.waitForTimeout(300).catch(() => undefined);
  }
}

async function addItemsViaSunatModal(
  page: Page,
  preferredScope: PageScope,
  draft: InvoiceDraft,
  profile: SiteProfile,
  config: AppConfig,
  onStep: StepReporter,
  validationWatcher?: SunatValidationWatcherController,
): Promise<void> {
  const itemDialogSelector = profile.sunat.itemDialogSelector;
  const itemAcceptSelector = profile.sunat.itemAcceptSelector;

  if (!itemDialogSelector || !itemAcceptSelector) {
    throw new Error("Faltan selectores del modal de ítems para SUNAT.");
  }

  const existingRowCount = await countVisibleItemRows(preferredScope, profile.sunat.itemRowSelector);
  validationWatcher?.pause("item-dialog");
  try {
    for (let index = 0; index < draft.items.length; index += 1) {
      const item = draft.items[index];
      const sanitizedDescription = sanitizeSunatItemDescription(item.description);
      await onStep(`Agregando item ${index + 1} de ${draft.items.length} en SUNAT`);
      await onStep(`Buscando el botón Adicionar para el item ${index + 1}.`);

      const addButton = await waitForSunatAddItemButtonWithRecovery(
        page,
        preferredScope,
        profile,
        config,
        onStep,
        index,
      );
      await onStep(`Botón Adicionar encontrado; abriendo el modal del item ${index + 1}.`);
      await clickSunatAction(page, addButton.locator, onStep, `Adicionar item ${index + 1}`);

    const addButton = await waitForAnyVisibleLocatorInPageTree(
      page,
      addItemButtonSelectors(profile.sunat.addItemButtonSelector),
      15_000,
      preferredScope,
    );
    await onStep(`Botón Adicionar encontrado; abriendo el modal del item ${index + 1}.`);
    await addButton.locator.click();

    const dialog = await waitForAnyVisibleLocatorInPageTree(
      page,
      itemDialogSelectors(itemDialogSelector),
      10_000,
      addButton.scope,
    );
    await onStep(`Modal del item ${index + 1} abierto; completaré los campos.`);

      const quantityField = await waitForAnyVisibleLocatorWithinRoot(
        dialog.locator,
        itemQuantitySelectors(profile.sunat.itemQuantitySelector),
        30_000,
      );
      await quantityField.fill(String(item.quantity));
      await onStep(`Cantidad del item ${index + 1} registrada: ${item.quantity}.`);

    const quantityField = await waitForAnyVisibleLocatorInPageTree(
      page,
      itemQuantitySelectors(profile.sunat.itemQuantitySelector),
      8_000,
      dialog.scope,
    );
    await quantityField.locator.fill(String(item.quantity));
    await onStep(`Cantidad del item ${index + 1} registrada: ${item.quantity}.`);

      await selectSunatTaxCategory(page, dialog.scope, profile, draft);

      const unitPriceValue = formatSunatCurrency(calculateSunatUnitPrice(item, draft));
      const unitPriceField = await waitForAnyVisibleLocatorWithinRoot(
        dialog.locator,
        itemUnitPriceSelectors(profile.sunat.itemUnitPriceSelector),
        30_000,
      );
      await typeIntoSunatCurrencyField(page, unitPriceField, unitPriceValue);
      await onStep(`Precio del item ${index + 1} registrado: ${unitPriceValue}.`);
      await triggerSunatItemAmountUpdate(page);
      await onStep(`Esperando que SUNAT calcule los montos del item ${index + 1}.`);
      await waitForSunatItemAmountPreview(page, dialog.scope);

      await onStep(`Buscando el botón Aceptar del item ${index + 1}.`);
      const targetRowCount = existingRowCount + index + 1;
      const dialogSelectorList = itemDialogSelectors(itemDialogSelector);
      await clickSunatItemAcceptAction(
        page,
        itemUnitMeasureSelectors(profile.sunat.itemUnitMeasureSelector),
        2_500,
        dialog.scope,
        dialogSelectorList,
        profile.sunat.itemRowSelector,
        targetRowCount,
        itemAcceptSelectors(itemAcceptSelector),
        onStep,
        `Aceptar item ${index + 1}`,
      );
      await onStep(`SUNAT aceptó el item ${index + 1} y espero que se cierre el modal.`);

      await waitForSunatItemAcceptance(
        page,
        preferredScope,
        dialogSelectorList,
        profile.sunat.itemRowSelector,
        targetRowCount,
        30_000,
        dialog.scope,
      );
      await onStep(`El modal del item ${index + 1} ya se cerró en SUNAT.`);

      if (profile.sunat.itemRowSelector) {
        await waitForMinimumItemRows(
          preferredScope,
          profile.sunat.itemRowSelector,
          existingRowCount + index + 1,
          1_500,
        )
          .then(() => onStep(`El item ${index + 1} ya aparece en la grilla principal de SUNAT.`))
          .catch(() => onStep(`No pude confirmar por conteo la grilla del item ${index + 1}; igual continuaré.`));
      }
    }
  } finally {
    validationWatcher?.resume();
  }
}

    const descriptionField = await waitForAnyVisibleLocatorInPageTree(
      page,
      itemDescriptionSelectors(profile.sunat.itemDescriptionSelector),
      8_000,
      dialog.scope,
    );
    await descriptionField.locator.fill(sanitizedDescription);
    await onStep(`Descripción del item ${index + 1} registrada.`);

  const customerSurfaceVisible = await isAnyVisibleLocatorInPageTree(
    page,
    [
      ...customerDocumentSelectors(profile.sunat.customerDocumentSelector),
      ...customerNameSelectors(profile.sunat.customerNameSelector),
      ...customerContinueSelectors(profile.sunat.customerContinueSelector ?? "text=Continuar"),
    ].filter(Boolean),
    preferredScope,
  ).catch(() => false);

  if (customerSurfaceVisible) {
    const continueButton = await tryWaitForBottomMostVisibleLocatorInPageTree(
      page,
      itemUnitPriceSelectors(profile.sunat.itemUnitPriceSelector),
      8_000,
      dialog.scope,
    );
    if (continueButton) {
      await onStep?.(
        `SUNAT seguía en la pantalla del cliente antes del item ${itemIndex + 1}; haré un Continuar adicional para llegar a los ítems.`,
      );
      await clickSunatAction(page, continueButton.locator, onStep, `Continuar previo al item ${itemIndex + 1}`);
      await waitForSunatProcessingToSettle(
        page,
        `el ingreso a la pantalla de ítems del item ${itemIndex + 1}`,
        onStep,
        20_000,
      );
      await dismissSunatContactValidationSurface(page, onStep);
    }
  }

  const addButtonAfterCustomerRecovery = await tryWaitForAnyVisibleLocatorInPageTree(
    page,
    addSelectors,
    3_000,
    preferredScope,
  );
  if (addButtonAfterCustomerRecovery) {
    return addButtonAfterCustomerRecovery;
  }

  const menuSearchVisible = await isAnyVisibleLocatorInPageTree(
    page,
    ["#txtBusca"],
    preferredScope,
  ).catch(() => false);

  if (menuSearchVisible && profile.sunat.postLoginMenuLabels?.length) {
    await onStep?.(
      `SUNAT volvió al menú antes del item ${itemIndex + 1}; reabriré «Emitir Boleta de Venta» antes de seguir.`,
    );
    await navigateSunatSolMenu(
      page,
      itemAcceptSelectors(itemAcceptSelector),
      8_000,
      dialog.scope,
    );
    await dismissSunatContactValidationSurface(page, onStep);
  }

  return waitForAnyVisibleLocatorInPageTree(page, addSelectors, 30_000, preferredScope);
}

async function clickSunatItemAcceptAction(
  page: Page,
  gridScope: PageScope,
  dialogScope: PageScope,
  dialogSelectors: string[],
  rowSelector: string | undefined,
  minimumRowCount: number,
  selectors: string[],
  onStep: StepReporter | undefined,
  label: string,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await hasSunatItemAcceptanceSucceeded(page, gridScope, dialogSelectors, rowSelector, minimumRowCount, dialogScope)) {
      await onStep?.(`SUNAT ya había aplicado ${label}; continuaré sin volver a buscar el botón.`);
      return;
    }

    await tryDismissGenericSunatDialog(page, onStep);
    await waitForSunatProcessingToSettle(
      page,
      preferredScope,
      itemDialogSelectors(itemDialogSelector),
      profile.sunat.itemRowSelector,
      existingRowCount + index + 1,
      15_000,
      dialog.scope,
    );
    await onStep(`El modal del item ${index + 1} ya se cerró en SUNAT.`);

    if (profile.sunat.itemRowSelector) {
      await waitForMinimumItemRows(
        preferredScope,
        profile.sunat.itemRowSelector,
        existingRowCount + index + 1,
        1_000,
      )
    ) {
      return true;
    }

    await tryDismissGenericSunatDialog(page).catch(() => undefined);
    await page.waitForTimeout(250).catch(() => undefined);
  }

  return false;
}

export function addItemButtonSelectors(primarySelector?: string): string[] {
  return uniqueSelectors([
    primarySelector ?? "",
    "span.dijitReset.dijitInline.dijitButtonText:has-text(\"Adicionar\")",
    "xpath=//*[contains(concat(' ', normalize-space(@class), ' '), ' dijitButtonText ') and contains(normalize-space(.), 'Adicionar')]/ancestor::*[self::a or self::button or @role='button'][1]",
    "xpath=//*[contains(concat(' ', normalize-space(@class), ' '), ' dijitButtonText ') and contains(normalize-space(.), 'Adicionar')]",
    "text=Adicionar",
    "xpath=//a[contains(normalize-space(.), 'Adicionar')]",
    "xpath=//input[contains(@value, 'Adicionar')]",
    "xpath=//button[contains(normalize-space(.), 'Adicionar')]",
  ]);
}

function itemDialogSelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#dialogItem",
    "text=Nuevo Item",
    "xpath=//*[@id='dialogItem']",
    "xpath=//*[contains(normalize-space(.), 'Nuevo Item')]",
  ]);
}

function itemAcceptSelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#item\\.botonAceptar",
    "#item\\.botonAceptar_label",
    "xpath=//*[@id='item.botonAceptar_label']/ancestor::*[@id='item.botonAceptar'][1]",
    "xpath=//*[@id='item.botonAceptar' and @role='button']",
    "text=Aceptar",
    "xpath=//*[@id='item.botonAceptar']",
    "xpath=//input[contains(@value, 'Aceptar')]",
    "xpath=//button[contains(normalize-space(.), 'Aceptar')]",
  ]);
}

function itemQuantitySelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#item\\.cantidad",
    "xpath=//*[@id='item.cantidad']",
  ]);
}

function itemDescriptionSelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#item\\.descripcion",
    "xpath=//*[@id='item.descripcion']",
  ]);
}

function itemUnitPriceSelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#item\\.precioUnitario",
    "xpath=//*[@id='item.precioUnitario']",
    "xpath=//*[@id='item.valorUnitario']",
  ]);
}

function itemCodeSelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#item\\.codigoItem",
    "xpath=//*[@id='item.codigoItem']",
    "xpath=//*[contains(normalize-space(.), 'Código') or contains(normalize-space(.), 'Codigo')]/following::input[not(@type='hidden') and not(@readonly) and not(@aria-hidden='true')][1]",
  ]);
}

function itemUnitMeasureSelectors(primarySelector: string): string[] {
  return uniqueSelectors([
    primarySelector,
    "#item\\.unidadMedida",
    "xpath=//*[@id='item.unidadMedida']",
    "xpath=//*[contains(normalize-space(.), 'Unidad de Medida')]/following::select[1]",
    "xpath=//*[contains(normalize-space(.), 'Unidad de Medida')]/following::input[@type='text'][1]",
  ]);
}

async function selectSunatTaxCategory(
  page: Page,
  preferredScope: PageScope,
  profile: SiteProfile,
  draft: InvoiceDraft,
): Promise<void> {
  const targetSelectors =
    draft.totals.tax > 0
      ? itemTaxedSelectors(profile.sunat.itemTaxedSelector)
      : itemExemptSelectors(profile.sunat.itemExemptSelector, profile.sunat.itemUnaffectedSelector);

  const radio = await tryWaitForAnyVisibleLocatorInPageTree(
    page,
    targetSelectors,
    5_000,
    preferredScope,
  );

  if (radio) {
    await radio.locator.check().catch(() => radio.locator.click().catch(() => undefined));
  }
}

function itemTaxedSelectors(primarySelector?: string): string[] {
  return uniqueSelectors([
    primarySelector ?? "",
    "#item\\.subTipoTB00",
    "xpath=//*[@id='item.subTipoTB00']",
    "xpath=//input[@type='radio' and @value='gra']",
    "xpath=//*[contains(normalize-space(.), 'Gravado')]/preceding::input[@type='radio'][1]",
  ]);
}

function itemExemptSelectors(primarySelector?: string, unaffectedSelector?: string): string[] {
  return uniqueSelectors([
    primarySelector ?? "",
    unaffectedSelector ?? "",
    "#item\\.subTipoTB01",
    "xpath=//*[@id='item.subTipoTB01']",
    "#item\\.subTipoTB02",
    "xpath=//*[@id='item.subTipoTB02']",
    "xpath=//*[contains(normalize-space(.), 'Exonerado')]/preceding::input[@type='radio'][1]",
    "xpath=//*[contains(normalize-space(.), 'Inafecto')]/preceding::input[@type='radio'][1]",
  ]);
}

async function waitForItemDialogToClose(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  preferredScope?: PageScope,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const dialog = await tryWaitForAnyVisibleLocatorInPageTree(page, selectors, 500, preferredScope);
    if (!dialog) {
      return;
    }
    await page.waitForTimeout(SUNAT_TIMING.itemDialogPollMs);
  }

  throw new Error("El modal de SUNAT para agregar ítems no se cerró después de aceptar.");
}

async function waitForSunatItemAcceptance(
  page: Page,
  gridScope: PageScope,
  dialogSelectors: string[],
  rowSelector: string | undefined,
  minimumRowCount: number,
  timeoutMs: number,
  dialogScope?: PageScope,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (rowSelector) {
      const visibleRows = await countVisibleItemRows(gridScope, rowSelector).catch(() => 0);
      if (visibleRows >= minimumRowCount) {
        return;
      }
    }

    const dialog = await tryWaitForAnyVisibleLocatorInPageTree(page, dialogSelectors, 500, dialogScope);
    if (!dialog) {
      return;
    }
    await page.waitForTimeout(SUNAT_TIMING.itemDialogPollMs);
  }

  await waitForItemDialogToClose(page, dialogSelectors, 1_000, dialogScope);

  if (rowSelector) {
    await waitForMinimumItemRows(gridScope, rowSelector, minimumRowCount);
    return;
  }

  throw new Error("El modal de SUNAT para agregar ítems no se cerró después de aceptar.");
}

async function countVisibleItemRows(scope: PageScope, rowSelector: string): Promise<number> {
  const rows = scope.locator(rowSelector);
  const count = await rows.count().catch(() => 0);
  let visibleCount = 0;

  for (let index = 0; index < count; index += 1) {
    if (await rows.nth(index).isVisible().catch(() => false)) {
      visibleCount += 1;
    }
  }

  return visibleCount;
}

async function waitForMinimumItemRows(
  scope: PageScope,
  rowSelector: string,
  minimumCount: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await countVisibleItemRows(scope, rowSelector)) >= minimumCount) {
      return;
    }
    if ("page" in scope) {
      await scope.page().waitForTimeout(SUNAT_TIMING.itemGridPollMs).catch(() => undefined);
    } else {
      await scope.waitForTimeout(SUNAT_TIMING.itemGridPollMs).catch(() => undefined);
    }
  }

  throw new Error("SUNAT no reflejó el ítem agregado en la grilla principal a tiempo.");
}

async function selectSunatItemKindAsGood(page: Page, preferredScope: PageScope): Promise<void> {
  const goodRadio = await tryWaitForAnyVisibleLocatorInPageTree(
    page,
    itemGoodSelectors(),
    5_000,
    preferredScope,
  );

  if (!goodRadio) {
    return;
  }

  await goodRadio.locator.check().catch(() => goodRadio.locator.click().catch(() => undefined));
}

function itemGoodSelectors(): string[] {
  return uniqueSelectors([
    "#item\\.subTipoTI01",
    "xpath=//*[@id='item.subTipoTI01']",
    "xpath=//input[@type='radio' and contains(@id, 'Bien')]",
    "xpath=//*[contains(normalize-space(.), 'Bien')]/preceding::input[@type='radio'][1]",
  ]);
}

async function setSunatUnitMeasure(locator: Locator, description: string): Promise<void> {
  const targetLabel = "UNIDAD";

  const selected = await locator.evaluate((element, target) => {
    if (element instanceof HTMLSelectElement) {
      const option = Array.from(element.options).find((candidate) =>
        (candidate.label || candidate.textContent || "").includes(target),
      );
      return option?.value || "";
    }

    if (element instanceof HTMLInputElement) {
      return element.value.includes(target) ? "__already_selected__" : "";
    }

    return "";
  }, targetLabel);

  if (selected === "__already_selected__") {
    return;
  }

  if (selected) {
    await locator.selectOption(selected).catch(() => undefined);
  }
}

async function setSunatDojoWidgetValue(
  page: Page,
  widgetId: string,
  rawValue: number | string,
  displayedValue = String(rawValue),
): Promise<void> {
  await page.evaluate(
    ({ widgetId, rawValue, displayedValue }) => {
      const globalWindow = window as typeof window & {
        dijit?: {
          byId?: (id: string) => {
            set?: (prop: string, newValue: unknown) => void;
            domNode?: Element | null;
            textbox?: HTMLInputElement | HTMLTextAreaElement | null;
            focusNode?: HTMLInputElement | HTMLTextAreaElement | null;
          } | null;
        };
      };
      const widget = globalWindow.dijit?.byId?.(widgetId) ?? null;
      const numericValue =
        typeof rawValue === "number" ? rawValue : Number.isFinite(Number(rawValue)) ? Number(rawValue) : null;

      if (widget?.set) {
        widget.set("value", numericValue ?? rawValue);
        widget.set("displayedValue", displayedValue);
      }

      const widgetNode =
        widget?.domNode instanceof Element
          ? widget.domNode.querySelector("input:not([type='hidden']), textarea, select")
          : null;
      const element = widget?.focusNode || widget?.textbox || widgetNode || document.getElementById(widgetId);

      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        element.value = displayedValue;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true }));
      }
    },
    { widgetId, rawValue, displayedValue },
  );
}

async function typeIntoSunatCurrencyField(page: Page, locator: Locator, value: string): Promise<void> {
  await locator.click();
  await locator.evaluate((element) => {
    if (element instanceof HTMLInputElement) {
      element.focus();
      element.setSelectionRange(0, element.value.length);
    }
  });
  await page.keyboard.press("Meta+A").catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await locator.pressSequentially(value, { delay: SUNAT_TIMING.currencyTypingDelayMs });
  await locator.blur();
}

async function fillSunatCustomerDocumentFieldExact(
  page: Page,
  locator: Locator,
  expectedValue: string,
): Promise<string> {
  await locator.click().catch(() => undefined);
  await locator.fill("").catch(() => undefined);
  await locator.fill(expectedValue).catch(() => undefined);

  let currentValue = await readLocatorValue(locator);
  if (currentValue === expectedValue) {
    return currentValue;
  }

  await locator.click().catch(() => undefined);
  await page.keyboard.press("Meta+A").catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await locator.pressSequentially(expectedValue, { delay: 25 }).catch(() => undefined);
  currentValue = await readLocatorValue(locator);
  if (currentValue === expectedValue) {
    return currentValue;
  }

  await locator
    .evaluate((element, value) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        element.value = value;
        element.setAttribute("value", value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true }));
      }
    }, expectedValue)
    .catch(() => undefined);

  return readLocatorValue(locator);
}

async function triggerSunatItemAmountUpdate(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const globalWindow = window as typeof window & {
        boleta?: {
          updateItemAmount?: () => void;
        };
      };
      globalWindow.boleta?.updateItemAmount?.();
    })
    .catch(() => undefined);
}

async function waitForSunatItemAmountPreview(
  page: Page,
  preferredScope: PageScope,
  timeoutMs = 5_000,
): Promise<void> {
  const previewSelectors = ["#item\\.precioConIGV", "#item\\.importeVenta"];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const previewValues = await Promise.all(
      previewSelectors.map(async (selector) => {
        const field = await tryWaitForAnyVisibleLocatorInPageTree(page, [selector], 250, preferredScope);
        return field ? readLocatorValue(field.locator) : "";
      }),
    );

    if (previewValues.some((value) => value && !/undefined/i.test(value))) {
      return;
    }

    await triggerSunatItemAmountUpdate(page);
    await page.waitForTimeout(SUNAT_TIMING.itemAmountPreviewPollMs);
  }
}

function buildSunatItemCode(description: string, index: number): string {
  const normalized = description
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .slice(0, 18)
    .toUpperCase();

  return normalized ? `${normalized}${index + 1}` : `ITEM${index + 1}`;
}

export function formatSunatCurrency(value: number): string {
  return roundSunatAmount(value).toFixed(SUNAT_CURRENCY_DECIMALS);
}

function sanitizeSunatItemDescription(description: string): string {
  const sanitized = description
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[,"'`-]/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return sanitized.slice(0, 60).trim();
}

export function calculateSunatUnitPrice(
  item: InvoiceDraft["items"][number],
  draft: InvoiceDraft,
): number {
  const quantity = Math.max(item.quantity, 1);
  const grossUnitPrice = item.total > 0 ? item.total / quantity : item.unitPrice;

  if (draft.totals.tax <= 0) {
    return roundSunatAmount(grossUnitPrice);
  }

  return roundSunatAmount(grossUnitPrice / 1.18);
}

async function ensureCustomerDocumentType(
  page: Page,
  locator: Locator,
  documentNumber: string,
  onStep?: StepReporter,
): Promise<void> {
  const targetOptionLabel = inferSunatDocumentTypeLabel(documentNumber);

  if (!targetOptionLabel) {
    return;
  }

  const normalizedTarget = targetOptionLabel
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (normalizedTarget.includes("identidad")) {
    await onStep?.(`SUNAT: forzaré el tipo de documento «${targetOptionLabel}» en el combo Dojo.`);
    await selectSunatInicioTipoDocumentoByLabel(page, targetOptionLabel, onStep);
    const stateAfterSelection = await readSunatInicioTipoDocumentoState(page);
    await onStep?.(
      `SUNAT: tras fijar el tipo de documento, quedó visible «${stateAfterSelection.visibleLabel || "(vacío)"}» y hidden tipoDocumento="${stateAfterSelection.hiddenCode || "(vacío)"}".`,
    );
    if (stateAfterSelection.hiddenCode && stateAfterSelection.hiddenCode !== "1") {
      await onStep?.(
        `SUNAT: el hidden tipoDocumento no quedó en código DNI (valor actual ${stateAfterSelection.hiddenCode}); lo corregiré a "1".`,
      );
      for (const scope of collectPageScopes(page)) {
        const updated = await scope
          .locator("body")
          .evaluate(() => {
            const hiddenInput = document.querySelector('input[type="hidden"][name="tipoDocumento"]');
            if (!(hiddenInput instanceof HTMLInputElement)) {
              return false;
            }
            hiddenInput.value = "1";
            hiddenInput.setAttribute("value", "1");
            hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
            hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          })
          .catch(() => false);
        if (updated) {
          break;
        }
      }
      const stateAfterCorrection = await readSunatInicioTipoDocumentoState(page);
      await onStep?.(
        `SUNAT: tras corregir, visible «${stateAfterCorrection.visibleLabel || "(vacío)"}» y hidden tipoDocumento="${stateAfterCorrection.hiddenCode || "(vacío)"}".`,
      );
    }
    return;
  }

  const matchesExistingValue = await locator.evaluate((element, target) => {
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }

    const normalizedTarget = target
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const normalizedValue = (element.value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    return normalizedValue.includes(normalizedTarget);
  }, targetOptionLabel);

  if (matchesExistingValue) {
    return;
  }

  const optionValue = await locator.evaluate((select, target) => {
    if (!(select instanceof HTMLSelectElement)) {
      return "";
    }

    const normalizedTarget = target
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const normalizedShortTarget = normalizedTarget.includes("identidad") ? "ident" : normalizedTarget;

    for (const option of Array.from(select.options)) {
      const normalizedLabel = (option.label || option.textContent || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

      if (
        normalizedLabel.includes(normalizedTarget) ||
        normalizedLabel.includes(normalizedShortTarget)
      ) {
        return option.value;
      }
    }

    return "";
  }, targetOptionLabel);

  if (!optionValue) {
    return;
  }

  await locator.selectOption(optionValue).catch(() => undefined);
}

function inferSunatDocumentTypeLabel(documentNumber: string): string | undefined {
  const sanitizedNumber = documentNumber.replace(/\D+/g, "");

  if (sanitizedNumber.length >= 7 && sanitizedNumber.length <= 10) {
    return "documento nacional de identidad";
  }

  if (sanitizedNumber.length === 11) {
    return "registro unico de contribuyentes";
  }

  return undefined;
}

function uniqueSelectors(selectors: string[]): string[] {
  return [...new Set(selectors.filter(Boolean))];
}

async function ensureRowCount(
  scope: PageScope,
  rowSelector: string,
  targetCount: number,
  addItemButtonSelector?: string,
): Promise<void> {
  let count = await scope.locator(rowSelector).count();

  while (count < targetCount) {
    if (!addItemButtonSelector) {
      throw new Error(
        "No hay suficientes filas de ítems disponibles y no se configuró un selector para agregar filas.",
      );
    }

    await scope.locator(addItemButtonSelector).first().click();
    count = await scope.locator(rowSelector).count();
  }
}

async function stopTraceSafely(
  context: BrowserContext,
  tracePath: string,
  artifacts: Artifact[],
  enabled: boolean,
): Promise<void> {
  if (!enabled) {
    return;
  }
  try {
    await context.tracing.stop({ path: tracePath });
    if (fs.existsSync(tracePath)) {
      artifacts.push({ kind: "trace", path: tracePath });
    }
  } catch {
    return;
  }
}

async function stopTraceChunkSafely(
  context: BrowserContext,
  tracePath: string,
  artifacts: Artifact[],
): Promise<void> {
  try {
    await context.tracing.stopChunk({ path: tracePath });
    if (fs.existsSync(tracePath)) {
      artifacts.push({ kind: "trace", path: tracePath });
    }
  } catch {
    /* tracing may not be active; ignore */
  }
}

function asErrorMessage(error: unknown): string {
  if (error instanceof AutomationError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Error desconocido en la automatización.";
}

function normalizeAutomationError(error: unknown, artifacts: Artifact[] = []): AutomationError {
  if (error instanceof OperatorCancelledError) {
    return error;
  }

  if (isBrowserClosedError(error)) {
    return new OperatorCancelledError(undefined, artifacts);
  }

  if (error instanceof AutomationError) {
    return error;
  }

  return new AutomationError(asErrorMessage(error), artifacts);
}

function isBrowserClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");

  return /Target page, context or browser has been closed|browser has been closed|page has been closed|context closed|Connection closed/i.test(
    message,
  );
}

async function isLoggedIn(page: Page, loggedInSelector?: string): Promise<boolean> {
  if (!loggedInSelector) {
    return false;
  }

  return page
    .locator(loggedInSelector)
    .first()
    .isVisible()
    .catch(() => false);
}

async function waitForLoginStep(
  page: Page,
  nextVisibleSelector?: string,
  loggedInSelector?: string,
): Promise<void> {
  const waiters: Array<Promise<unknown>> = [
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
  ];

  if (nextVisibleSelector) {
    waiters.push(
      page
        .locator(nextVisibleSelector)
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => undefined),
    );
  }

  if (loggedInSelector) {
    waiters.push(
      page
        .locator(loggedInSelector)
        .first()
        .waitFor({ state: "visible", timeout: 60_000 })
        .catch(() => undefined),
    );
  }

  await Promise.race(waiters);
}
