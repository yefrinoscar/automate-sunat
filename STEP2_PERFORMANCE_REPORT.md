# Paso 2 (SUNAT) · Reporte de performance y optimizaciones

Reporte del análisis y las optimizaciones aplicadas al **Paso 2** del flujo
(`registrar_facturas_sunat`): tomar las ventas detectadas en el Paso 1, llenar
el formulario de Boleta de Venta Electrónica en SOL, emitir y descargar el PDF.

## 1. Qué hace el Paso 2

Definido en `coordinator.ts` y `browser.ts`. Por cada venta del Paso 1 se ejecuta
este pipeline:

```
abrir_sunat            → abrir portal + login + recorrer menú SOL
cargar_factura_en_sunat → llenar DNI/RUC, autofill nombre, items vía modal
esperar_revision       → validación automática (pasa instantáneo)
enviar_factura         → click Emitir + Aceptar + descargar PDF/XML
```

Implementación concreta:

- `SunatPortalEmitter.prepareSubmission()` — `src/browser.ts`
- `PendingSunatSubmission.submit()` — `src/browser.ts`
- `addItemsViaSunatModal()` — `src/browser.ts`
- `processSunatRegistrations()` — `src/coordinator.ts`

## 2. Línea base histórica (datos de `data/automation.db`)

Análisis con `tools/analyze-step2.cjs` sobre 23 corridas con actividad SUNAT:

| Métrica | Valor |
|---|---|
| Tiempo total acumulado en Paso 2 | **42 min 02 s** |
| Boletas emitidas OK | 7 |
| Boletas fallidas | 15 |
| Boletas canceladas | 5 |
| Promedio por boleta emitida con éxito | ≈ 6 min |

Distribución por sub‑paso (suma de todas las corridas):

| Sub‑paso | Tiempo acumulado | % del Paso 2 |
|---|---|---|
| `abrir_sunat` | 13 m 32 s | 32 % |
| `cargar_factura_en_sunat` | **22 m 10 s** | **53 %** ← cuello de botella |
| `esperar_revision` | 6 ms | 0 % (automático) |
| `enviar_factura` (Emitir + descarga PDF) | 6 m 19 s | 15 % |

Patrón observado por boleta:

| Run | Boleta | Abrir | Cargar | Emitir+descarga | Total |
|---|---|---|---|---|---|
| `d3b31e05` | 3231533458 (1.ª del run) | 1 m 12 s | 4 m 12 s | 1 m 53 s | **7 m 17 s** |
| `d3b31e05` | 3231553043 (sesión reusada) | — | — | 1 m 33 s | **1 m 33 s** |
| `1dfd7c18` | 3231511758 | 32 s | 3 m 02 s | 58 s | **4 m 32 s** |

**Patrón:** primera boleta del run = 5–7 min · siguientes con sesión cacheada =
1.5–2.5 min.

Errores dominantes (35 eventos):
- 11× `No se pudo completar el registro en SUNAT…` (rollup)
- 10× `Flujo cancelado porque el operador cerró el navegador.`
- 5× `SUNAT no cargó el nombre del cliente…`
- 7× `«Sin documento» / Dojo no respondió.`

## 3. Optimizaciones aplicadas (commit actual)

Cambios en `src/browser.ts`:

### a) Reutilización de sesión + página entre boletas

`SunatPortalEmitter` ahora mantiene una `invoicePage` viva entre boletas:

- `getOrOpenInvoicePage` reusa `page` si está abierta; si no, crea una nueva.
- Login + dismiss del aviso del buzón + recorrido del menú SOL **solo se
  ejecutan en la primera boleta**.
- En reuso: probe corto (1.5 s) para `customerDocumentSelectors`; si está listo,
  llena el form directo. Si no, `navigateToBoletaForm(30 s)`.
- Detección de sesión expirada: si la URL cae en `api-seguridad.sunat.gob.pe` o
  `loginMenuSol`, marca `needsFreshLogin = true`.
- Tras éxito, `releaseInvoicePage("success")` hace `page.goto(invoiceUrl)` para
  dejar la pestaña en el menú SOL listo para la siguiente boleta.
- Tras error o cancelación → `discardInvoicePage()` cierra la pestaña.

> ⚠️ **Pendiente:** el reuso de `page` con `goto(invoiceUrl)` puede romperse si
> `navigateSunatSolMenu` abre nueva pestaña en SOL (visto en la corrida del
> 2026-04-28; ver §5).

### b) Tracing por boleta sin reabrir tracing del contexto

Antes: `tracing.start/stop` por boleta, forzaba a recrear el contexto.

Ahora:
- `tracing.start(...)` una sola vez en la primera boleta.
- Por cada boleta: `tracing.startChunk()` al entrar y
  `tracing.stopChunk({ path: tracePath })` al salir → cada boleta sigue teniendo
  su propia traza ZIP.

### c) `waitForTimeout` fijos eliminados / reducidos

Donde el siguiente paso ya hace su propia espera condicional, dropé los timers:

| Antes | Ahora | Ahorro/boleta |
|---|---|---|
| `waitForTimeout(3_000)` post-fill DNI | eliminado (`waitForAutofilledCustomerName` ya hace polling 250 ms) | ~3 s |
| `waitForTimeout(1_000)` después del primer Continuar | eliminado | ~1 s |
| `waitForTimeout(750)` después del click Emitir | eliminado | ~0.75 s |
| `waitForTimeout(750)` después del Aceptar de confirmación | eliminado | ~0.75 s |
| `waitForTimeout(1_000)` después del primer Continuar en wizard | eliminado | ~1 s |
| `waitForTimeout(1_000)` después de la pantalla opcional | eliminado | ~1 s |
| `waitForTimeout(1_000)` post-Aceptar pantalla traslado | eliminado | ~1 s |
| `waitForTimeout(750)` post-«Ver más tarde» | eliminado | ~0.75 s |
| `waitForTimeout(500)` por cada label del menú SOL | eliminado | ~2.5 s (5 labels) |

### d) Timeouts de lookup ajustados a la realidad

| Selector | Antes | Ahora |
|---|---|---|
| Aviso «Ver más tarde» del buzón | 7.5 s | 2.5 s |
| Campo doc. cliente | 30 s | 15 s |
| Botón Continuar inicial | 10 s | 6 s |
| Autofill nombre — lookup / deadline | 30 s / 20 s | 8 s / 15 s |
| `firstContinue` en wizard | 30 s | 15 s |
| `secondContinue` opcional | 15 s | 10 s |
| Procesamiento «primer Continuar» | 20 s | 15 s |
| Procesamiento «pantalla opcional» | 60 s | 30 s |
| Espera tras pantalla opcional | 45 s | 25 s |
| Marker pantalla opcional | 8 s | 3 s |
| Botón Emitir | 30 s | 15 s |
| `successSelector` final | 30 s | 25 s |
| Modal ítem — Adicionar | 30 s | 15 s |
| Modal ítem — apertura | 30 s | 10 s |
| Modal ítem — cantidad / desc / precio / Aceptar | 30 s | 8 s c/u |
| Modal ítem — unidad de medida | 5 s | 2.5 s |
| Confirmación cierre del modal | 30 s | 15 s |
| `closeSuccessSelector` post-éxito | 5 s | 3 s |
| `waitForMinimumItemRows` final | 1.5 s | 1 s |

## 4. Run de validación (2026-04-28T05:23 UTC, runId `0a0a6b67`)

Tras aplicar todas las optimizaciones se lanzó un Paso 2 real con 8 ventas. Se
instrumentó `data/step2-timings.ndjson` con timestamp ms por cada `onStep`.

Resultado:

```
duración total: 14m 5s
ventas en cola: 8
emitidas OK:    1
falladas:       1
canceladas:     1
no procesadas:  5  (run abortado por la cancelación)
```

### Tiempos por boleta

| # | Boleta | Resultado | Total | Notas |
|---|---|---|---|---|
| 1 | `3234028285` | **fallida** | **8m 12.88s** | Sesión SUNAT expiró a mitad (modal de validación atascó el flujo). Falló al buscar el botón «Adicionar» después de re-login. |
| 2 | `3233937144` | **OK (PDF descargado)** | **5m 40.80s** | prepareSubmission 4m 12.81s · submit (Emitir + Aceptar + descarga) 1m 25.84s · post-submit DB 2.16 s |
| 3 | `3233826335` | **cancelada** | 8.79 s | Tras éxito de la 2.ª, `releaseInvoicePage("success")` hizo `page.goto(invoiceUrl)` y al re-navegar el menú SOL el navegador cerró la pestaña activa → `OperatorCancelledError` → matando el run completo. |
| 4–8 | (no procesadas) | — | — | Run abortado por la cancelación. |

### Top 5 gaps en la boleta exitosa (3233937144)

```
22.93 s  click Continuar           → pantalla opcional       (waitForSunatProcessingToSettle)
19.59 s  moneda                     → agregar item 1          (addButton + dialog)
16.89 s  modal cerrado              → item visible en grilla  (waitForSunatItemAcceptance)
16.80 s  click Aceptar item         → modal cerrado           (waitForSunatItemAcceptance)
13.43 s  buscando Continuar         → Encontré Continuar      (tryWaitForBottomMostVisibleLocator)
```

Estos 5 gaps son **89 s = 26 %** del tiempo de la boleta y corresponden a
procesamiento server-side de SUNAT (`Procesando…` con `#waitMessage`) → no se
pueden recortar desde el cliente.

## 5. Problemas detectados en la corrida del 2026-04-28

### Problema A · Modal de "Validación de datos de contacto" en bucle

`startSunatValidationIframeSearchLogger` encontró el iframe `#ifrVCE` pero no
pudo cerrar `#btnFinalizarValidacionDatos` (el botón nunca quedó visible /
clickable). El logger entró en bucle de 1.5 s polleando, mientras el flujo
principal seguía intentando llenar el form **por debajo del modal**. SUNAT
terminó echando la sesión por inactividad y redirigió al login.

**Resultado:** 8 min perdidos en la primera boleta + boleta fallida.

**Fix propuesto (pendiente):**
- Si tras N intentos (~30 s) el modal no se cierra, cerrar la página, hacer
  screenshot/dump, abortar **esa boleta** y arrancar la siguiente con pestaña
  fresca, sin tumbar el run.

### Problema B · `releaseInvoicePage("success")` rompe la siguiente boleta

`releaseInvoicePage("success")` hace `page.goto(invoiceUrl)` (que es el menú
top del SOL), y al re-ejecutar `navigateSunatSolMenu("Empresas")` SUNAT abrió
una **pestaña nueva**, dejando la pestaña que `invoicePage` apuntaba como
cerrada → `page.once("close")` disparó `OperatorCancelledError` → el coordinator
abortó todo el run.

**Fix propuesto (pendiente):** revertir el cache de `page` entre boletas y
mantener solo el cache del `BrowserContext` (cookies/storageState). Cada
boleta abre `newPage()`; el login se salta automáticamente porque el storage
state ya tiene la sesión SUNAT (~25 s ahorrados respecto al código original,
sin riesgo de "pestaña fantasma").

## 6. Tooling

Scripts añadidos en `tools/`:

| Script | Propósito |
|---|---|
| `analyze-step2.cjs` | Tiempos por sub-paso, run y venta a partir de `data/automation.db` |
| `analyze-step2-errors.cjs` | Ranking de errores y últimos 10 |
| `analyze-step2-timings.cjs` | Tabla por boleta a partir de `data/step2-timings.ndjson` (instrumentación fina) |
| `run-step2-with-tracking.cjs` | Espera ventas pendientes, dispara Paso 2 y monitorea progreso |
| `inspect-step2-run.cjs` | Detalle de un run (status, attempts, errores) |

Instrumentación añadida:
- `src/timing-tracker.ts` · `wrapTimingReporter` envuelve un `StepReporter` y
  escribe NDJSON a `data/step2-timings.ndjson` con timestamp ms.
- En `coordinator.ts/processSunatRegistrations` se aplica el wrap por cada
  boleta y se emiten marks `sale_start`, `prepare_submission_start/end`,
  `submit_start/end`, `sale_end`.

## 7. Cómo reproducir

```bash
# 1. Limpiar mediciones previas
del data\step2-timings.ndjson    # Windows
# rm -f data/step2-timings.ndjson  # Unix

# 2. Levantar server (en otra terminal)
npm run dev

# 3. Disparar el watcher (espera ventas pendientes y dispara Paso 2 solo)
node tools/run-step2-with-tracking.cjs

# 4. Lanzar Paso 1 (manual run) — opcionalmente con filtro de fechas
curl -X POST http://localhost:3030/api/run/manual ^
  -H "Content-Type: application/json" ^
  -d "{\"falabellaDocumentsSearchFrom\":\"2026-04-25\",\"falabellaDocumentsSearchTo\":\"2026-04-28\"}"

# 5. Cuando el watcher reporte "Run terminado", correr el análisis
node tools/analyze-step2-timings.cjs
node tools/inspect-step2-run.cjs <runId>
```

## 8. Próximos pasos sugeridos (orden de impacto)

1. **Aplicar fix A y B** (problemas §5) → debería bajar la tasa de error y
   estabilizar runs largos.
2. **Detectar campo "Sin documento" en DOM real** y dump de HTML cuando falla
   `ensureCustomerDocumentType` → reduce los 7 errores históricos por Dojo.
3. **Mensaje en panel** "Paso 2 en curso, no cierres el navegador" para reducir
   los 10 cancelados accidentales del histórico.
4. **Endpoint en `server.ts`** que exponga un agregado de `analyze-step2.cjs`
   para verlo en el panel.
