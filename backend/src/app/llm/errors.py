"""User-facing call diagnostics never include remote exception payloads."""

from typing import Literal, NamedTuple

from openai import APIConnectionError, APIStatusError, APITimeoutError


class CallFailure(NamedTuple):
    code: Literal["timeout", "provider_error"]
    message: str


def describe_call_failure(
    error: Exception, operation: Literal["模型验证", "阅读翻译", "模型调用"], timeout_seconds: float
) -> CallFailure:
    if isinstance(error, (TimeoutError, APITimeoutError)):
        # An SDK timeout can arrive before the local deadline.
        return CallFailure("timeout", f"{operation}超时（本次等待上限 {timeout_seconds:g} 秒）")
    if isinstance(error, APIConnectionError):
        message = "模型服务连接失败"
    elif isinstance(error, APIStatusError):
        message = f"模型服务返回 HTTP {error.status_code}"
    elif isinstance(error, ValueError):
        message = "模型未返回完整的可见文本"
    else:
        message = f"{operation}失败，请检查地址、凭据和模型参数"
    return CallFailure("provider_error", message)
