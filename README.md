# Sistema de Fichaje de Encuestadores — Equipos Consultores

Aplicación web (HTML + Firebase) para que los encuestadores registren el inicio
y el fin de su jornada desde su casa, y para que las coordinadoras supervisen el
cumplimiento, gestionen días libres, detecten jornadas incompletas y exporten
los datos a Excel.

Cumple con la especificación **specfichajeencuestadores.md** (R1 a R7) y reutiliza
la estética de marca de Equipos Consultores (naranja `#E96436` sobre gris oscuro,
tipografía Montserrat).

---

## 1. ¿Qué hace?

| Requerimiento | Dónde |
|---|---|
| **R1** Fichaje de entrada/salida (hora del **servidor**, un par por día) | Vista **Mi jornada** (encuestador) |
| **R2** Gestión de encuestadores (estado activo/inactivo, días y hora de fin) | **Encuestadores** (coordinadora) |
| **R3** Días libres (fecha o rango, a uno o varios encuestadores) | **Días libres** (coordinadora) |
| **R4** Detección de jornada incompleta + **correo** al coordinador | **Cierre del día** + Cloud Function `cierreDelDia` (23:59) |
| **R5** Panel de supervisión con navegación por fechas | **Panel del día** (coordinadora) |
| **R6** Exportación a Excel (.xlsx) por rango de fechas | **Exportar** (coordinadora) |
| **R7** Autenticación y roles (encuestador / coordinadora) | Firebase Auth + reglas de Firestore |

> El fichaje es **de confianza**: no hay verificación de identidad ni de
> ubicación (no-objetivo del spec). La hora que se guarda siempre es la del
> servidor (`serverTimestamp`), nunca la del dispositivo.

---

## 2. Estructura del proyecto

```
.
├── public/
│   └── index.html          # La aplicación completa (SPA autónoma)
├── functions/
│   ├── index.js            # Cloud Functions: correo de cierre (R4) + eliminarUsuario
│   └── package.json
├── firestore.rules         # Reglas de seguridad (roles y permisos)
├── firestore.indexes.json  # Índice compuesto para el historial de fichajes
├── firebase.json           # Configuración de Hosting + Firestore + Functions
├── .firebaserc             # ID del proyecto Firebase
└── README.md
```

---

## 3. Puesta en marcha (paso a paso)

### 3.1. Crear el proyecto Firebase

1. Entrá a <https://console.firebase.google.com> y **creá un proyecto**.
2. **Authentication → Sign-in method → Email/Password → Habilitar.**
3. **Firestore Database → Crear base de datos** (modo producción, región a elección).
4. **Configuración del proyecto → Tus apps → Web (`</>`)** y copiá el objeto
   `firebaseConfig`.

### 3.2. Configurar la app

En **`public/index.html`**, reemplazá el bloque `window.firebaseConfig` (arriba
de todo) con los valores de tu proyecto:

```js
window.firebaseConfig = {
  apiKey: "…",
  authDomain: "tu-proyecto.firebaseapp.com",
  projectId: "tu-proyecto",
  storageBucket: "tu-proyecto.appspot.com",
  messagingSenderId: "…",
  appId: "…"
};
```

En **`.firebaserc`**, reemplazá `"TU_PROYECTO"` por el `projectId` real.

### 3.3. Instalar la CLI y desplegar

```bash
npm install -g firebase-tools     # una sola vez
firebase login

# Reglas e índices de Firestore
firebase deploy --only firestore

# La aplicación web
firebase deploy --only hosting

# Las Cloud Functions: correo de cierre (ver 3.5) y eliminarUsuario
# (borra credencial de Auth + doc al eliminar un usuario). Requieren plan Blaze.
cd functions && npm install && cd ..
firebase deploy --only functions
```

Al terminar, `firebase deploy --only hosting` te muestra la URL pública
(`https://tu-proyecto.web.app`).

### 3.4. Crear la primera coordinadora (bootstrap)

Como solo una coordinadora puede dar de alta a otros, la **primera** se crea a
mano una única vez:

1. **Authentication → Users → Add user**: cargá email y contraseña de la
   coordinadora. Copiá el **UID** que se genera.
2. **Firestore → Iniciar colección `usuarios`** → documento con **ID = ese UID**
   y estos campos:

   ```
   email:      coordinacion@equipos.com.uy   (string)
   nombre:     Nombre Apellido               (string)
   rol:        coordinadora                  (string)
   activo:     true                          (boolean)
   diasSemana: [1,2,3,4,5]                   (array de números)
   horaFin:    18:00                         (string)
   ```

3. Entrá a la app con ese usuario. Desde **Encuestadores → Nuevo usuario**
   ya podés crear al resto **sin salir de tu sesión**. Al elegir el rol el
   formulario pide **email** para las coordinadoras y **cédula** para los
   encuestadores.

> `diasSemana` usa 0=Domingo … 6=Sábado. `[1,2,3,4,5]` = lunes a viernes.

### Ingreso a la app

La pantalla de login pide **usuario** y **clave**:

- **Coordinadoras** ingresan con su **email**.
- **Encuestadores** ingresan con su **cédula** (solo los dígitos).

Firebase Authentication trabaja con email, por lo que a cada encuestador se le
crea un email interno determinístico a partir de su cédula
(`<cédula>@encuestador.reloj` por defecto; configurable con
`window.CEDULA_DOMAIN`). Ese email no se usa para enviar correos: es solo la
identidad de acceso. Por eso el **restablecimiento de contraseña por correo**
solo aplica a las coordinadoras; la clave inicial del encuestador la define la
coordinadora al darlo de alta.

### 3.5. Correo de cierre del día (R4)

El envío efectivo del correo lo hace la extensión oficial **Trigger Email from
Firestore**; la app y la Cloud Function solo dejan el mensaje en la colección
`mail`.

1. **Extensions → Buscar “Trigger Email from Firestore” → Instalar.**
   (Requiere el plan **Blaze**; tiene capa gratuita generosa.)
2. Durante la instalación configurá:
   - **SMTP connection URI**: el de tu proveedor de correo, p. ej.
     `smtps://usuario@equipos.com.uy:CLAVE@smtp.tuservidor.com:465`
   - **Email documents collection**: `mail`
   - **Default FROM**: `Fichaje <no-reply@equipos.com.uy>`
3. Definí quién recibe el correo: en la app, **Notificaciones**, escribí los
   correos destinatarios (uno por línea). Si lo dejás vacío, se envía a todas las
   coordinadoras dadas de alta.
4. La función `cierreDelDia` se ejecuta automáticamente a las **23:59 (hora de
   Uruguay)** y encola el correo solo si hay jornadas incompletas.
   Para recibir también un correo “todo en orden” los días sin incumplimientos,
   agregá el campo `enviarSiempre: true` al documento `config/notificaciones`.

> **¿Sin plan Blaze?** La app sigue siendo 100 % funcional para R1, R2, R3, R5,
> R6 y R7. En **Cierre del día** ves la lista de incompletos y podés **copiar el
> resumen** para pegarlo en un correo manual. El envío automático y el botón
> “Enviar por correo” necesitan la extensión instalada.

---

## 4. Uso

### Encuestador — *Mi jornada*
- Un clic en **Fichar entrada** al empezar y **Fichar salida** al terminar.
- La pantalla muestra el estado del día (sin fichar / entrada a las HH:MM /
  jornada completa) y un reloj en vivo.
- Debajo, el historial de los últimos días.

### Coordinadora
- **Panel del día**: tarjetas resumen + tabla de todos los encuestadores activos
  con entrada, salida y estado. Los incompletos se destacan en rojo y aparecen
  primero. Se puede navegar a otras fechas. Desde el botón **Editar** de cada
  fila la coordinadora corrige manualmente la hora de entrada/salida del día
  (o borra el fichaje dejando ambas vacías); los fichajes editados quedan
  marcados con ✎.
- **Encuestadores**: alta (con **cédula**), edición, activar/desactivar,
  **eliminar**, días de trabajo y hora de fin. El reset de contraseña por correo
  está disponible para las coordinadoras (que ingresan con email). Eliminar
  usa la Cloud Function `eliminarUsuario` (Admin SDK): borra la credencial de
  Authentication (el email/cédula queda libre para reutilizar) y el documento de
  la nómina; los fichajes y días libres ya registrados no se borran.
- **Días libres**: marcá una fecha o rango para uno o varios encuestadores;
  listado por mes con opción de quitar.
- **Cierre del día**: los que quedaron incompletos (lo mismo que va por correo).
- **Exportar**: rango de fechas → archivo `.xlsx`. Incluye solo los días con
  entrada fichada (entrada+salida o solo entrada); los días sin fichaje se omiten.
- **Archivo liquidación**: rango de fechas → archivo `.csv` (separado por `;`, sin
  encabezados) con una fila por fichaje **completo** (entrada y salida). Columnas:
  nombre, fecha (DD/MM/AA), cédula, `Reloj`, `JN`, `Por Hora`, `N/A`, `0`, cantidad
  de horas (salida − entrada, decimal) y diez columnas con `0`.
- **Notificaciones**: destinatarios del correo de cierre.

---

## 5. Modelo de datos (Firestore)

- **`usuarios/{uid}`** — `nombre, rol ('encuestador'|'coordinadora'), activo,
  diasSemana:[0-6], horaFin:'HH:MM', createdAt` + el identificador de acceso:
  `email` para coordinadoras, `cedula` para encuestadores.
- **`fichajes/{uid}_{YYYY-MM-DD}`** — `uid, email, nombre, fecha, entrada (ts),
  salida (ts|null), corregido, updatedAt` — el campo `email` guarda el
  identificador visible (cédula del encuestador); el ID determinístico
  garantiza **un solo par entrada/salida por día**.
- **`diasLibres/{uid}_{YYYY-MM-DD}`** — `uid, email, nombre, fecha, motivo,
  createdBy, createdAt`
- **`config/notificaciones`** — `destinatarios:[email], enviarSiempre?`
- **`mail/{auto}`** — cola de la extensión Trigger Email (`to`, `message`).

Las **reglas de seguridad** (`firestore.rules`) garantizan que un encuestador
solo pueda leer/escribir sus propios fichajes y que las funciones de gestión
sean exclusivas de las coordinadoras (R7).

---

## 6. Notas sobre decisiones del spec

- **Corte único diario**: la evaluación de ausencias se hace en un solo proceso a
  las 23:59 (recomendación de las *preguntas abiertas*), no por encuestador.
- **Sin incumplimientos → sin correo** por defecto (configurable con
  `enviarSiempre`).
- **Zona horaria** fijada en `America/Montevideo` para que fechas, días de la
  semana y horas sean consistentes sin depender del dispositivo. Se puede cambiar
  en `window.APP_TZ` (index.html) y en `functions/index.js`.
- La **corrección manual de fichajes** (P1) no está incluida en esta v1; la
  coordinadora puede editar en la consola de Firestore si hiciera falta.

---

## 7. Desarrollo local (opcional)

```bash
firebase emulators:start        # Hosting + Firestore + Functions locales
```

O simplemente serví `public/` con cualquier servidor estático (la app se conecta
al proyecto Firebase real definido en `firebaseConfig`).
