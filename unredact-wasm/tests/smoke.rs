use wasm_bindgen_test::*;

#[wasm_bindgen_test]
fn test_ping() {
    assert_eq!(unredact_core::ping(), "unredact-core");
}
