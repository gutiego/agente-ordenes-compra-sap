---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra SAP de Periferia - maestros, controles RC1–RC10, estructura de la OC y OC retroactivas.
---

# Conocimiento del proceso: órdenes de compra en SAP

## El paquete de una solicitud

Cada compra llega a administración por correo con tres piezas: la **solicitud** (Excel, normalizado como `solicitud.json`), la **cotización** del proveedor (`cotizacion.txt`) y el **correo de aprobación** del líder (`aprobacion.json`). En algunos casos llega además la **factura** (`factura.txt`), señal de que la compra ya ocurrió.

## Maestros

- **Proveedores**: código SAP, NIT (sin dígito de verificación), nombre, condiciones de pago e indicador de IVA por defecto, y si está activo.
- **Centros de costo**: subáreas válidas y aprobadores con su tope (en la moneda de la solicitud, IVA incluido).
- **Indicadores de IVA**: C0 excluido, C1 IVA 19 %, C2 IVA 5 %.
- **Condiciones de pago**: Z000 inmediato, Z015, Z030 y Z060 días fecha factura.

## Controles (RC1–RC10)

| # | Regla | Tipo |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre normalizado) y está activo. | Bloqueo |
| RC2 | Hay aprobación, contiene "Aprobado" y viene de un aprobador del centro de costo. | Bloqueo |
| RC3 | El valor total no supera el tope del aprobador (si el aprobador no es del centro, se compara con el tope máximo del centro). | Bloqueo |
| RC4 | La subárea pertenece al centro de costo. | Bloqueo |
| RC5 | Cotización vs solicitud: diferencia ≤ 2 %. Si excede o no hay cotización: confirmación con ambos valores. | Confirmación |
| RC6 | Sin indicador de IVA: se deriva del proveedor y se pide confirmación. | Confirmación + derivado |
| RC7 | Sin condiciones de pago: se derivan del proveedor. Solo se informa. | Derivado |
| RC8 | Factura con fecha anterior a la solicitud: OC **retroactiva**. Confirmación y marca en el log de control. | Confirmación |
| RC9 | La aprobación no puede ser anterior a la solicitud. Si lo es: confirmación. | Confirmación |
| RC10 | cantidad × valor unitario = valor total (± 1). Si no: bloqueo. | Bloqueo |

Los umbrales (2 %, ± 1, sociedad 1000, numeración desde 4500000001, patrones de unidad) viven en `src/knowledge/reglas-oc.json`.

## La OC en SAP

- Sociedad y organización de compras **1000**. Posiciones numeradas de 10 en 10.
- **Texto breve** de la posición: máximo 40 caracteres (límite de SAP); se recorta en límite de palabra.
- **Unidad**: `H` si la compra es por horas, `MES` si es mensual, `UN` en otro caso.
- El precio y la cantidad salen siempre de la **solicitud aprobada**, nunca de la cotización: si difieren, se confirma, no se ajusta.
- Las confirmaciones aceptadas viajan como **excepciones** con quién las confirmó.
- La evidencia de aprobación es el correo convertido a texto/PDF; su sha256 va en el payload.

## Acciones sugeridas típicas

- Proveedor inexistente o inactivo → Datos Maestros crea o reactiva el proveedor; o el solicitante elige uno registrado.
- Aprobador sin autoridad o tope insuficiente → pedir aprobación a un aprobador del centro con tope suficiente o escalar.
- Subárea o centro de costo inválidos → confirmar con el solicitante.
- Aritmética de la solicitud inconsistente → el solicitante corrige la solicitud.

## OC retroactivas

Una OC es retroactiva cuando la factura es anterior a la solicitud: la compra ocurrió sin OC previa. La dirección quiere **medirlas**; el agente las crea solo con confirmación y quedan con `retroactiva = true` en `out/control.csv`.
