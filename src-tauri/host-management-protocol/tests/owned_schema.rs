//! The authoritative schema closes the envelope/DTO shape; executable codecs
//! also enforce UTF-16/UTF-8 budgets and cross-field arithmetic invariants.
use myagents_host_management_protocol::{Frame, encode_frame};
use serde_json::{Value, json};
fn envelope(method: &str, key: &str, value: Value, result: bool) -> Value {
    let message = if result {
        json!({"kind":"response","requestId":"00000000-0000-4000-8000-000000000001","result":{"kind":key,"data":value}})
    } else {
        json!({"kind":"request","requestId":"00000000-0000-4000-8000-000000000001","method":method,"params":{key:value}})
    };
    json!({"namespace":"host.management","version":1,"senderSequence":1,"channelId":"00000000-0000-4000-8000-000000000002","message":message})
}
fn codec(value: &Value) -> bool {
    serde_json::from_value::<Frame>(value.clone()).is_ok_and(|f| encode_frame(&f).is_ok())
}
#[test]
fn authoritative_owned_schema_and_codec_match_shared_fixtures() {
    let schema: Value =
        serde_json::from_str(include_str!("../schemas/host-management-v1.schema.json")).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    for (fixture, method, request_key, result_key) in [
        (
            include_str!("fixtures/remote-assets-v1.json"),
            "session.assets.v1",
            "remoteAssets",
            "remote-assets",
        ),
        (
            include_str!("fixtures/remote-mobile-v1.json"),
            "session.mobile.v1",
            "remoteMobile",
            "remote-mobile",
        ),
    ] {
        let fixtures: Value = serde_json::from_str(fixture).unwrap();
        for (name, result, valid) in [
            ("requests", false, true),
            ("results", true, true),
            ("invalidRequests", false, false),
            ("invalidResults", true, false),
        ] {
            for value in fixtures[name].as_array().unwrap() {
                let key = if result { result_key } else { request_key };
                let frame = envelope(method, key, value.clone(), result);
                if valid {
                    assert!(
                        validator.is_valid(&frame),
                        "{method}/{name}: {:?}",
                        validator
                            .iter_errors(&frame)
                            .map(|e| e.to_string())
                            .collect::<Vec<_>>()
                    );
                    assert!(codec(&frame));
                    if !result {
                        let mut unknown_wrapper = frame.clone();
                        unknown_wrapper["message"]["params"]["providerEndpoint"] =
                            json!("https://not-a-native-port.invalid");
                        assert!(!validator.is_valid(&unknown_wrapper));
                        assert!(!codec(&unknown_wrapper));
                    }
                    let mut unknown = value.clone();
                    unknown["providerEndpoint"] = json!("https://not-an-admission-field.invalid");
                    assert!(!validator.is_valid(&envelope(method, key, unknown, result)));
                } else {
                    assert!(
                        !(validator.is_valid(&frame) && codec(&frame)),
                        "{method}/{name}"
                    );
                }
                if !result {
                    // Method switching cannot reinterpret an otherwise valid DTO.
                    let other = if method == "session.mobile.v1" {
                        "session.assets.v1"
                    } else {
                        "session.mobile.v1"
                    };
                    assert!(!validator.is_valid(&envelope(other, key, value.clone(), false)));
                }
            }
        }
    }
}
