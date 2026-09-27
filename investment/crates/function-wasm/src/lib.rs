use wasm_bindgen::prelude::*;
#[wasm_bindgen]
pub fn domain_version() -> u32 {
    robinlab_domain::interface::INTERFACE_VERSION
}
#[wasm_bindgen]
pub fn domain_invoke(input: &str) -> String {
    robinlab_domain::interface::invoke_json(input)
}
#[wasm_bindgen]
pub fn parse_workbook(bytes: &[u8]) -> Result<String, JsValue> {
    let rows = robinlab_domain::workbook::parse_excel_data(bytes)
        .map_err(|_| JsValue::from_str("Workbook parsing failed"))?;
    serde_json::to_string(&rows).map_err(|_| JsValue::from_str("Workbook serialization failed"))
}
