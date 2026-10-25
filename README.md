# Disfraz

Anonimiza documentos **en local** antes de usar una IA y **restaura** los datos reales en la respuesta. Código, nombres e interfaz originales.

## Flujo

1. **Anonimizar**: pega texto → «Detectar» → desmarca falsos positivos → copia el resultado (con instrucción opcional para la IA).
2. **Restaurar**: pega la respuesta de la IA → recupera los datos reales (tolera corchetes perdidos y mayúsculas).
3. **Archivos**: arrastra archivos o carpetas (`.txt .md .csv .json .docx .xlsx .pdf`). Se crea una copia `.anonimo` junto al original; el original no se toca.

## Tres modos

- **Marcadores** (`[DNI_1]`, `[PERSONA_2]`…): reversible; el mismo dato siempre recibe el mismo marcador, también entre archivos.
- **Datos falsos realistas**: nombres, DNI/NIE, CIF, IBAN, tarjetas, emails, teléfonos, direcciones… verosímiles y con dígitos de control válidos. Reversible y coherente.
- **Irreversible** (`[DNI]`): no se guarda nada; no se puede restaurar.

## Qué detecta

DNI/NIE (con letra validada), CIF (dígito de control), IBAN (mod 97), tarjetas (Luhn), email, teléfonos, direcciones postales, códigos postales, matrículas, IP, URLs, empresas (S.L./S.A.…), nombres de personas (tratamientos, nombres de pila + apellidos, `APELLIDOS, NOMBRE`), claves/secretos (API keys, JWT), y opcionalmente fechas e importes. Más términos personalizados (`Proyecto Fénix = PROYECTO`).

## Extras sobre lo básico

- **Comprobación de fugas** tras anonimizar.
- **Expediente cifrado** (`.anoni`, scrypt + AES-256-GCM): guarda sesión, términos personalizados y tipos activos para retomar el caso.
- **Texto oculto en PDF** (fuente diminuta o fuera de página, típico de inyección de instrucciones): se avisa en el lote.
- **Revisión manual** de cada detección antes de aplicar. En PDF hay enlace «Revisar»: ves la página, quitas cajas con un clic y tapas a mano lo que no se detectó arrastrando.
- **Modelo local de nombres** (opcional): en Ajustes se descarga una vez (~180 MB, desde huggingface.co, solo al pulsar) y detecta nombres sueltos como «José Ramirez». Después funciona sin red.
- **Lote por carpeta** con sesión compartida (coherencia entre documentos del expediente).
- **Tachado real de PDF**: cajas negras sobre cada dato y PDF reconstruido solo con imágenes (sin texto, metadatos ni texto oculto debajo). Si la página es un escaneo, **OCR local** (Tesseract, español, sin red). Alternativa: extraer a `.docx`.
- **PDF «sustituir»**: en vez de cajas negras, el dato se cambia por su marcador (o dato falso, según el modo) dibujado en el sitio, y el PDF lleva una capa de texto invisible ya anonimizada para que una IA pueda leerlo. Los marcadores quedan en la sesión.
- **Sesión recordada**: al cerrar y reabrir, la sesión sigue disponible (cifrada con el usuario de Windows, DPAPI). No se guarda en modo irreversible; «Nueva sesión» la borra.
- **Imágenes** (`.png .jpg`: fotos de DNI, capturas): OCR + tachado; sale un PNG nuevo sin EXIF/GPS. El OCR puede fallar en fotos borrosas: revisa el resultado.
- **Restaurar archivos** devueltos por la IA (`txt md csv json docx xlsx`) con un clic; `.docx` y `.xlsx` conservan el formato.
- **Word y Excel conservan el formato** (se edita el XML en el sitio) y se limpian los restos ocultos: autor y empresa, miniatura, comentarios y sus autores, textos alternativos, enlaces, cabeceras y pies, datos incrustados, cachés de tablas dinámicas y vínculos externos. Las imágenes incrustadas se pasan por OCR y se tapan. Tras limpiar se comprueba todo el paquete y se avisa si queda algo.
- **PDF con texto e imágenes**: también se lee (OCR) el texto de las imágenes incrustadas.
- **Tapar todas las apariciones**: en la revisión de PDF, lo que marques a mano se tapa en todo el documento.
- **Revisar antes de aplicar** en todos los formatos (txt, csv, docx, xlsx…): lista de valores detectados; desmarca los que no quieras tocar.
- **Perfiles** (laboral, legal, sanitario, financiero) que activan los tipos adecuados; nuevos tipos NSS y nº de expediente/autos/historia clínica/factura.
- **Informe de auditoría** (`.md` + `.json`): fecha, huella SHA-256 del original, modo y recuentos por tipo; nunca incluye datos reales.
- **Interfaz renovada**: tema claro/oscuro (sigue al sistema, botón para cambiar), vista «antes y después» con los datos resaltados por color según su tipo (clic en el original = incluir/dejar sin tocar; ratón sobre un dato del resultado = ver el real), tabla de resultados con progreso por archivo, resumen por tipo, aviso al copiar y atajo `Ctrl+Intro`.
- Interfaz sin red: CSP estricta, sin `nodeIntegration`, sin ninguna llamada de red.

## Usar

```
npm install
npm start        # ejecutar
npm test         # 29 pruebas
npm run dist     # instalador en dist\Disfraz Setup 0.2.0.exe
```

Instalador sin firmar: SmartScreen puede avisar («Más información → Ejecutar de todas formas»).

## Límites conocidos

- En PDF escaneados, el OCR no lee bien títulos enormes o letras claras sobre fondo oscuro: usa «Revisar» y arrastra una caja sobre ellos.
- Sin el modelo opcional, los nombres se detectan por reglas: revisa la lista antes de aplicar. Nombres sin tratamiento ni nombre de pila común pueden escaparse; añádelos como término personalizado.

## Funcionalidades recomendadas (siguientes pasos)

1. **Modo bandeja/portapapeles**: atajo global que anonimiza lo copiado y restaura al pegar.

## Aviso

Disfraz ayuda a ocultar datos personales, pero **no garantiza detectarlos todos**. Revisa siempre el resultado antes de compartirlo. Licencia MIT (ver `LICENSE`), sin ninguna garantía.
