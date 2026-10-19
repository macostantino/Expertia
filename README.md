# Expertia · Agenda visual + Google Calendar

Next.js (App Router) + Supabase (Postgres, Realtime, Edge Functions). El repo estaba vacío, así que esta
rama arma el esquema mínimo y la agenda completa.

## Backend (`supabase/`)

| Pieza | Qué hace |
|---|---|
| `migrations/…_agenda_schema.sql` | Tablas, RLS y constraint de exclusión `appointments_no_overlap` (gist sobre `[starts_at, ends_at + buffer)`). |
| `migrations/…_agenda_functions.sql` | `_slots` / `_range_free` (única fuente de verdad), `get_slots` (paciente: solo `available`/`busy`), `get_agenda_pro` (profesional: motivo detallado), reservas con revalidación transaccional (`book_appointment`, `pro_create_appointment`, `pro_block`, `pro_reschedule`, `cancel_appointment`…), outbox hacia Google y broadcast Realtime. |
| `migrations/…_agenda_cron.sql` | pg_cron: expira pendientes (1 min), cola de Google (1 min), polling de lectura + renovación de canales (15 min). |
| `migrations/…_gcal_helpers.sql` | RPC atómicas para las edge functions (reemplazo de cache, revocación, claim de refresh). |
| `functions/gcal-*` | OAuth, selección de calendarios, refresh del cache, webhook de Google, worker (outbox/poll). |
| `tests/agenda.test.sql` | Tests SQL: privacidad de `get_slots`, doble reserva, buffer, motivos del profesional, RLS, pendientes expirados. |

### Decisiones
- **Realtime**: el RLS impide que un paciente reciba filas de turnos ajenos, así que no se usa `postgres_changes`. Un trigger emite un broadcast público `agenda:<professional_id>` **sin datos** y cada cliente vuelve a llamar `get_slots`.
- **Doble reserva**: `_create_appointment` toma un advisory lock por profesional, expira pendientes vencidos, revalida el slot (incluye Google y bloqueos, que el constraint no cubre) e inserta; el constraint de exclusión es la red final (`slot_taken`).
- **pending_payment**: bloquea mientras `expires_at > now()`; un job (y cada reserva) lo pasa a `expired`.
- **Google – lectura**: calendarios que bloquean y donde la app no escribe → `freeBusy` (solo rangos). El calendario de escritura → `events.list` con `fields` mínimos (sin título ni descripción) para descartar eventos propios (`extendedProperties.private.expertia_appointment_id` o `gcal_event_id`). Solo se guardan rangos en `gcal_busy`. Cache de 5 min (`gcal_needs_refresh`) invalidado por el watch channel; polling cada 15 min.
- **Google – tokens**: AES-GCM con `GCAL_TOKEN_KEY`; `gcal_accounts` sin policies (solo service role). Si Google revoca, `gcal_revoke` limpia el cache, crea una notificación y la agenda sigue solo con datos internos.
- **Scopes**: `calendar.events` + `calendar.freebusy` **+ `calendar.calendarlist.readonly`** (Google lo exige para listar los calendarios a elegir).

### Configuración
- Secrets de las edge functions: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GCAL_TOKEN_KEY` (`openssl rand -base64 32`), `GCAL_STATE_SECRET`, `APP_URL`.
- Redirect URI autorizada en Google: `https://<ref>.supabase.co/functions/v1/gcal-oauth-callback`.
- Vault (para pg_cron): `functions_url` y `service_role_key`. Realtime Broadcast público habilitado.
- Frontend: copiar `.env.example` a `.env.local`.

## Frontend (`src/`)
- `/book/[professionalId]` — paciente: slots verdes clickeables, grises no clickeables; semana (desktop) / día (mobile).
- `/agenda` — profesional: grilla semanal con leyenda fija; click en slot (bloquear / turno manual), click en turno (detalle, reprogramar, cancelar, ausente); arrastrar para bloquear varias horas; vista día/lista en mobile.
- `/settings/calendar` — conectar Google, elegir calendarios que bloquean y calendario de escritura.
- Accesibilidad: cada estado = color + icono + texto/tooltip; la paleta (`lib/agenda/palette.ts`) se valida con contraste AA en light y dark (`npm test`).

## Tests
`npm test` (tiempo/layout/contraste) · `npm run typecheck` · `npm run test:sql` (Postgres local con `PGHOST/PGPORT/PGUSER`).
