import { AppQuestionsSection } from "./AppQuestionsSection";
import { PaymentSection } from "./PaymentSection";
import { SalesChannelSection } from "./SalesChannelSection";

/**
 * What only a new staff order asks for, in the order form's side column: the
 * apps' checkout questions, how it is paid, and where it came in from. The
 * create route renders it into `OrderForm` (`createSections`), so the edit
 * route, which never shows these, never downloads them.
 */
export function OrderCreateSections() {
  return (
    <>
      <AppQuestionsSection />
      <PaymentSection />
      <SalesChannelSection />
    </>
  );
}
