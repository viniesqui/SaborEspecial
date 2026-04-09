# Almuerzos CEEP

Aplicacion web estatica y liviana para administrar la venta diaria de almuerzos usando Google Sheets como almacenamiento.

## Lo que resuelve

- Muestra el menu del dia.
- Muestra cuantos almuerzos quedan disponibles.
- Respeta el maximo diario de 15 almuerzos.
- Registra solicitudes sin tiquete fisico.
- Lleva reporte de pagos en tiempo real.
- Muestra una lista de compras para cocina.
- Guarda el detalle del menu junto con cada venta.

## Enfoque para internet lento

- No usa frameworks ni librerias externas.
- Solo carga HTML, CSS y JavaScript planos.
- Guarda el ultimo estado localmente en el navegador.
- Incluye Service Worker para reutilizar archivos estaticos.
- Reduce llamadas al servidor con refresco cada 30 segundos.

## Estructura

- `index.html`: interfaz principal.
- `styles.css`: estilos.
- `app.js`: logica cliente.
- `config.js`: configuracion del endpoint.
- `sw.js`: cache local de archivos estaticos.
- `google-apps-script/Code.gs`: backend para Google Sheets.
- `google-apps-script/README.md`: guia de configuracion del backend.

## Publicacion

Puede publicar esta carpeta como sitio estatico en:

- GitHub Pages
- Netlify
- Vercel
- Google Sites por medio de un iframe o enlace

Si cuando dijo "Google Pages" se referia a `GitHub Pages`, esta estructura ya funciona muy bien ahi.

## Backend con MongoDB Atlas

Si quiere usar MongoDB Atlas, mantenga el frontend en GitHub Pages y despliegue el backend en Vercel.

### Variables de entorno en Vercel

- `MONGODB_URI`
- `MONGODB_DB_NAME=ceep_lunches`

### Colecciones esperadas

- `settings`
- `menus`
- `orders`

### Documento inicial en `settings`

```json
{
  "key": "app_config",
  "timezone": "America/Costa_Rica",
  "maxMeals": 15,
  "salesStart": "10:00",
  "salesEnd": "12:00",
  "deliveryWindow": "12:00 - 12:30",
  "disableSalesWindow": true,
  "message": "Venta maxima de 15 almuerzos por dia."
}
```

### Documento inicial en `menus`

```json
{
  "dayKey": "2026-04-09",
  "title": "Casado con pollo",
  "description": "Arroz, frijoles, ensalada, pollo y fresco natural",
  "price": 1000,
  "active": true
}
```

### Endpoints

- `GET /api/dashboard`
- `POST /api/orders`

### Configuracion del frontend

En `config.js`, reemplace:

```js
apiBaseUrl: "PEGUE_AQUI_SU_URL_DE_VERCEL_API"
```

por algo como:

```js
apiBaseUrl: "https://su-proyecto.vercel.app/api"
```

## Uso local

Abra `index.html` con un servidor estatico simple o publique el sitio directamente.

Si quiere probar localmente y tiene Python:

```bash
python3 -m http.server 8080
```

Luego abra `http://localhost:8080`.

## Siguiente paso recomendado

1. Configurar la hoja y el Apps Script.
2. Pegar la URL del Web App en `config.js`.
3. Publicar esta carpeta en el hosting estatico de su preferencia.

## Precio actual

El precio esperado por almuerzo es `1000` colones. En la hoja `Settings`, use:

- `menuPrice` = `1000`

## Pruebas sin horario

Si quiere desactivar temporalmente el limite de horario para hacer pruebas, en la hoja `Settings` use:

- `disableSalesWindow` = `true`
