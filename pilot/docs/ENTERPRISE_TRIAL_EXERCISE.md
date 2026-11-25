# MeritX enterprise trial exercise

## Solo walkthrough with a trial link

On the synthetic demo service, open **Trial links for organizers** on the sign-in page.
Enter the organizer key and, optionally, a short participant note such as "Acme HR
pilot" (up to 60 characters) so you can recognize the link later. Select **Generate
link** and send the link privately to
one participant. The link is valid for 48 hours. The participant selects **Start
trial as HR** and can switch between **HR**, **Attorney**, and **Employee** at the
top of the workspace. One active browser uses the link at a time.

1. As HR, start a case with a fictional reference and request. The trial supplies
   the sample employee automatically.
2. As the attorney, accept the request and invite the sample employee.
3. As the employee, accept the invitation, review the sample consent, and submit
   fictional questionnaire answers.
4. As the attorney, open the case and request a sample employment letter.
5. As the employee, upload a sample text file, select it under **Document requests**,
   and submit it. Switch to the attorney again to accept it, then check progress as HR.

The **Trial roles** card tracks these steps from the case itself. It shows the next
step, offers a button to switch to the role that owns it, and points back to HR or the
employee when the attorney returns a request or a document. It also shows when the trial ends.

From the same card the participant can:

- **Start over**: select it twice to discard the trial case and begin again as HR.
  The two-hour limit and the 20-upload allowance carry over, so starting over never
  extends the trial.
- **Share feedback with your organizer**: rate the walkthrough from 1 (hard) to 5
  (easy), name the step where they needed help, and add an optional comment. The form
  opens on its own when the walkthrough is complete. Sending again replaces the earlier
  feedback.

### Reviewing trial activity

Enter the organizer key on the sign-in page and select **View trial activity**. Each
link shows its note, whether it has been opened, whether it is in progress, how many of
the 10 steps are done, how many times the participant started over, the last activity,
and any feedback. This view holds no case content. It is kept in memory, so it is
cleared when the demo service restarts. Links remain valid until they expire, but
activity from before the restart is lost. Each entry is kept for one day after its link
expires.

Each link opens an isolated workspace. Use fictional information and sample files.
Progress is temporary and resets if the service restarts, the trial ends, or its
two-hour session expires. Reopening an unexpired link after a reset starts a new case.

To enable links, set `PILOT_TRIAL_ORGANIZER_KEY` independently of `PILOT_DEMO_PASSWORD`
in the synthetic demo service's environment. Use a randomly generated value of at
least 32 bytes and keep it in the host's secret store. The production Pilot entry
point does not use this setting.

## Team walkthrough with existing demo accounts

Open [MeritX Workspace](https://meritx.us/workspace/). Use the trial password shared
privately by the organizer. Use fictional details and sample files. The demo clears
trial activity when it restarts, so complete the exercise together in one session.

| Role | Demo email | Task |
|---|---|---|
| HR | `enterprise@preview.example.test` | Start case `TRIAL-001` for the demo employee. After each handoff, check who needs to act next. |
| Attorney | `lawyer@preview.example.test` | Accept the request and invite the employee. After the questionnaire arrives, request a signed employment letter. Return the first file with a reason and accept the replacement. |
| Employee | `employee2@preview.example.test` | Accept the invitation, read the sample consent, submit fictional questionnaire answers, and respond to the document request. Submit the replacement after the attorney returns the first file. |

Prepare two fictional text files before starting. One can say “Sample letter, unsigned.”
The other can say “Sample letter, signed by Demo Manager.”

For each handoff, note what you expected, what you saw, and any step where you needed
help. At the end, HR should be able to identify the case's stage and next owner.

Keep each role signed in in its own browser profile. After a handoff, HR can use
**Refresh progress**, and the employee can use **Refresh cases** or **Refresh document
requests** if the case is already open. Check that the employee can tell when an answer
is still a draft and that a returned document request moves back to the top of **My cases**.
