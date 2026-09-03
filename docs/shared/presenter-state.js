// Reine Entscheidungslogik fuers Presenter-View, ohne DOM/Supabase-Zugriff.

export function buildPresenterView({ session, questions, responses, participantCount }) {
  const status = session?.status ?? 'lobby';
  const currentQuestionId = session?.current_question_id ?? null;

  const rows = [...questions]
    .sort((a, b) => a.position - b.position)
    .map((question) => {
      const isCurrent = question.id === currentQuestionId;
      const badge = isCurrent && (status === 'open' || status === 'closed') ? status : 'pending';
      const responseCount = responses.filter((r) => r.question_id === question.id).length;
      return { question, badge, responseCount };
    });

  return {
    status,
    rows,
    participantCount,
    canClose: status === 'open',
    canFinish: status === 'open' || status === 'closed',
  };
}
