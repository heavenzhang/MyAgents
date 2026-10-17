//! A processing receipt precedes queue admission; keep its owner until evidence.
use std::{future::Future, time::Duration};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AdmissionState {
    Pending,
    Accepted,
    Rejected,
    Busy,
    Exited,
    Expired,
}
/// Only a correlated operation receipt settles admission. An unrelated active
/// turn or session snapshot cannot establish that a queued send was accepted.
pub(crate) fn exact_receipt_state(
    status: &myagents_host_management_protocol::RemoteReceiptStatus,
) -> AdmissionState {
    use myagents_host_management_protocol::RemoteReceiptStatus;
    match status {
        RemoteReceiptStatus::Accepted => AdmissionState::Accepted,
        RemoteReceiptStatus::Rejected => AdmissionState::Rejected,
        _ => AdmissionState::Pending,
    }
}
pub(crate) async fn retain_owner<O, F, Fut>(
    owner: O,
    maximum: Duration,
    interval: Duration,
    mut poll: F,
) -> (O, AdmissionState)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = AdmissionState>,
{
    let deadline = tokio::time::Instant::now() + maximum;
    loop {
        let state = poll().await;
        if state != AdmissionState::Pending {
            return (owner, state);
        }
        if tokio::time::Instant::now() >= deadline {
            return (owner, AdmissionState::Expired);
        }
        tokio::time::sleep(
            interval.min(deadline.saturating_duration_since(tokio::time::Instant::now())),
        )
        .await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct Owner(Arc<AtomicUsize>);
    impl Drop for Owner {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    #[test]
    fn uncertain_receipts_cannot_be_settled_by_another_sessions_running_turn() {
        use myagents_host_management_protocol::RemoteReceiptStatus as Status;
        for status in [Status::Processing, Status::Unconfirmed, Status::NotFound] {
            assert_eq!(exact_receipt_state(&status), AdmissionState::Pending);
        }
        assert_eq!(
            exact_receipt_state(&Status::Accepted),
            AdmissionState::Accepted
        );
        assert_eq!(
            exact_receipt_state(&Status::Rejected),
            AdmissionState::Rejected
        );
    }
    #[tokio::test]
    async fn configuration_wait_outlasts_background_idle_poll_without_losing_owner() {
        let owners = Arc::new(AtomicUsize::new(1));
        let held = owners.clone();
        let began = tokio::time::Instant::now();
        let job = async move {
            let (owner, state) = retain_owner(
                Owner(held),
                Duration::from_secs(5),
                Duration::from_millis(50),
                || async {
                    if began.elapsed() < Duration::from_millis(2400) {
                        AdmissionState::Pending
                    } else {
                        AdmissionState::Accepted
                    }
                },
            )
            .await;
            assert_eq!(state, AdmissionState::Accepted);
            assert_eq!(owner.0.load(Ordering::SeqCst), 1);
            drop(owner);
        };
        // The renderer/transport can close while Node is still configuring its MCPs.
        let observe = async {
            tokio::time::sleep(Duration::from_millis(2100)).await;
            assert_eq!(owners.load(Ordering::SeqCst), 1);
        };
        tokio::join!(job, observe);
        assert_eq!(owners.load(Ordering::SeqCst), 0);
    }
}
