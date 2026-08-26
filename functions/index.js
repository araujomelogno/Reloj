/**
 * Cloud Functions — Sistema de fichaje de encuestadores
 *
 * cierreDelDia: se ejecuta todos los días a las 23:59 (hora de Uruguay),
 * detecta los encuestadores activos que debían trabajar, no tenían día libre
 * y quedaron con la jornada incompleta (no fichó / fichó entrada pero no salida),
 * y deja UN correo en la colección `mail` para que la extensión
 * "Trigger Email from Firestore" lo envíe al/los coordinador/es (R4).
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const TZ = "America/Montevideo";
const MAIL_COLLECTION = "mail";
const REGION = "us-central1";

// ── Utilidades de fecha en la zona de referencia ──
function fechaHoyTZ() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const o = {};
  parts.forEach((p) => (o[p.type] = p.value));
  return `${o.year}-${o.month}-${o.day}`;
}
function weekday(fecha) {
  const [y, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Dom .. 6=Sáb
}
function fechaCorta(f) {
  const [y, m, d] = f.split("-");
  return `${d}/${m}/${y}`;
}

exports.cierreDelDia = onSchedule(
  { schedule: "59 23 * * *", timeZone: TZ, region: REGION },
  async () => {
    const fecha = fechaHoyTZ();
    const wd = weekday(fecha);
    logger.info(`Cierre del día ${fecha} (weekday ${wd})`);

    const [usnap, fsnap, lsnap, csnap] = await Promise.all([
      db.collection("usuarios").get(),
      db.collection("fichajes").where("fecha", "==", fecha).get(),
      db.collection("diasLibres").where("fecha", "==", fecha).get(),
      db.doc("config/notificaciones").get(),
    ]);

    const fMap = {};
    fsnap.forEach((d) => (fMap[d.data().uid] = d.data()));
    const libres = new Set();
    lsnap.forEach((d) => libres.add(d.data().uid));

    const incompletos = [];
    const coordinadoras = [];
    usnap.forEach((docu) => {
      const u = docu.data();
      const uid = docu.id;
      if (u.rol === "coordinadora" && u.email) coordinadoras.push(u.email);
      if (u.rol !== "encuestador" || !u.activo) return;
      if (!(u.diasSemana || []).includes(wd)) return; // hoy no trabaja
      if (libres.has(uid)) return; // día libre
      // Identificador visible del encuestador: cédula (o email en altas previas al cambio).
      const ident = u.cedula || u.email || "";
      const f = fMap[uid];
      if (!f || !f.entrada) {
        incompletos.push({ nombre: u.nombre || ident, email: ident, motivo: "No fichó" });
      } else if (!f.salida) {
        incompletos.push({ nombre: u.nombre || ident, email: ident, motivo: "Fichó entrada pero no salida" });
      }
    });

    // Destinatarios: config/notificaciones.destinatarios o, en su defecto, todas las coordinadoras.
    const cfg = csnap.exists ? csnap.data() : {};
    let destinatarios = Array.isArray(cfg.destinatarios) ? cfg.destinatarios.filter(Boolean) : [];
    if (!destinatarios.length) destinatarios = coordinadoras;
    if (!destinatarios.length) {
      logger.warn("No hay destinatarios configurados; no se envía correo.");
      return;
    }

    // Por defecto solo se envía si hay incumplimientos (ver preguntas abiertas del spec).
    // Poné config/notificaciones.enviarSiempre = true para recibir también el "todo en orden".
    if (!incompletos.length && cfg.enviarSiempre !== true) {
      logger.info("Sin jornadas incompletas; no se envía correo.");
      return;
    }

    const filas = incompletos
      .map(
        (r) =>
          `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">${r.nombre}` +
          `<br><span style="color:#888;font-size:12px;">${r.email}</span></td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #eee;">${r.motivo}</td></tr>`
      )
      .join("");

    const html =
      `<div style="font-family:Arial,sans-serif;color:#333;max-width:640px;">` +
      `<div style="background:#3A3838;padding:20px 24px;">` +
      `<span style="color:#E96436;font-weight:800;font-size:18px;">Equipos Consultores</span>` +
      `<span style="color:#fff;font-weight:600;"> · Fichaje de encuestadores</span></div>` +
      `<div style="padding:24px;"><h2 style="color:#3A3838;margin:0 0 4px;">Cierre del día — ${fechaCorta(fecha)}</h2>` +
      (incompletos.length
        ? `<p style="color:#B83A26;font-weight:700;">${incompletos.length} encuestador(es) con jornada incompleta:</p>` +
          `<table style="border-collapse:collapse;width:100%;font-size:14px;"><thead><tr>` +
          `<th style="text-align:left;padding:8px 12px;background:#f7f7f7;">Encuestador</th>` +
          `<th style="text-align:left;padding:8px 12px;background:#f7f7f7;">Situación</th></tr></thead>` +
          `<tbody>${filas}</tbody></table>`
        : `<p style="color:#1E9E57;font-weight:700;">Sin jornadas incompletas. Todos los encuestadores activos cumplieron. ✅</p>`) +
      `<p style="color:#999;font-size:12px;margin-top:24px;">Mensaje automático del sistema de fichaje.</p></div></div>`;

    const text =
      `Cierre del día — ${fechaCorta(fecha)}\n\n` +
      (incompletos.length
        ? `Encuestadores con jornada incompleta (${incompletos.length}):\n` +
          incompletos.map((r) => `• ${r.nombre} (${r.email}) — ${r.motivo}`).join("\n")
        : "Sin jornadas incompletas. Todos los encuestadores activos cumplieron.");

    await db.collection(MAIL_COLLECTION).add({
      to: destinatarios,
      message: {
        subject: `Cierre del día ${fechaCorta(fecha)} — ${incompletos.length ? incompletos.length + " incompleto(s)" : "todo en orden"}`,
        html,
        text,
      },
    });

    logger.info(`Correo encolado para ${destinatarios.length} destinatario(s); ${incompletos.length} incompleto(s).`);
  }
);

/**
 * eliminarUsuario: función callable que borra por completo a un usuario.
 * Solo la puede invocar una coordinadora. Elimina la credencial de Firebase
 * Authentication (para que el email/cédula quede libre para reutilizar) y el
 * documento de la nómina `usuarios/{uid}`. No borra fichajes ni días libres.
 */
exports.eliminarUsuario = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Necesitás iniciar sesión.");
  }
  const callerUid = request.auth.uid;
  const targetUid = request.data && request.data.uid;

  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "Falta el identificador del usuario a eliminar.");
  }
  if (targetUid === callerUid) {
    throw new HttpsError("failed-precondition", "No podés eliminar tu propia cuenta.");
  }

  // Solo una coordinadora puede eliminar usuarios.
  const callerSnap = await db.doc(`usuarios/${callerUid}`).get();
  if (!callerSnap.exists || callerSnap.data().rol !== "coordinadora") {
    throw new HttpsError("permission-denied", "Solo una coordinadora puede eliminar usuarios.");
  }

  // 1) Credencial de Authentication (si ya no existe, seguimos igual).
  try {
    await admin.auth().deleteUser(targetUid);
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      logger.error(`No se pudo eliminar la credencial de ${targetUid}`, e);
      throw new HttpsError("internal", "No se pudo eliminar la credencial del usuario.");
    }
    logger.warn(`La credencial de ${targetUid} no existía; se elimina solo el documento.`);
  }

  // 2) Documento de la nómina.
  await db.doc(`usuarios/${targetUid}`).delete();

  logger.info(`La coordinadora ${callerUid} eliminó al usuario ${targetUid}.`);
  return { ok: true };
});
