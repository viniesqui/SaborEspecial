# Google Apps Script y Google Sheets

Este backend usa una sola hoja de calculo de Google Sheets y un proyecto de Google Apps Script publicado como Web App.

## 1. Crear la hoja

Cree una hoja de Google Sheets con una pestana llamada `Settings`.

En `Settings` agregue estas columnas:

| key | value |
| --- | --- |
| timezone | America/Costa_Rica |
| maxMeals | 15 |
| salesStart | 10:00 |
| salesEnd | 12:00 |
| deliveryWindow | 12:00 - 12:30 |
| menuTitle | Casado con pollo |
| menuDescription | Arroz, frijoles, ensalada, pollo y fresco natural |
| menuPrice | 2500 |
| message | Venta maxima de 15 almuerzos por dia. |

La hoja `Orders` se crea automaticamente cuando llegue la primera compra.

## 2. Crear el Apps Script

1. Abra la hoja.
2. Entre a `Extensiones > Apps Script`.
3. Pegue el contenido de `Code.gs`.
4. Guarde el proyecto.

## 3. Desplegar como Web App

1. Seleccione `Implementar > Nueva implementacion`.
2. Elija `Aplicacion web`.
3. Ejecute como: su cuenta.
4. Acceso: `Cualquier persona con el enlace`.
5. Copie la URL final del Web App.

## 4. Conectar el frontend

Abra `config.js` y reemplace:

```js
apiBaseUrl: "PEGUE_AQUI_SU_URL_DE_APPS_SCRIPT"
```

por la URL del Web App.

## 5. Menu diario

Para cambiar el menu del dia solo actualice estos valores en `Settings`:

- `menuTitle`
- `menuDescription`
- `menuPrice`
- `message`

## 6. Estado de pagos

El sistema guarda:

- Metodo de pago
- Referencia o comprobante
- Estado del pago
- Menu vendido
- Precio
- Fecha y hora

Si desea que Ana marque pagos SINPE como confirmados, puede editar la columna `paymentStatus` en la hoja `Orders`.
